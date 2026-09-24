#!/bin/bash
# Checks whether $1 (a YouTube video or /live URL) is live; if so, records
# it from the start, uploads it to R2, and dispatches a recording-ready
# event for upload-youtube.yml to pick up.
# Set SKIP_UPLOAD=1 to record only, without uploading/dispatching.
# Set YT_DLP_PROXY (e.g. socks5://host:port) to route yt-dlp through a
# proxy — needed on GitHub Actions, whose datacenter IPs YouTube blocks.
set -e -o pipefail
R2_BUCKET="yt-liverec-recordings"
url="$1"
proxy_args=()
[ -n "$YT_DLP_PROXY" ] && proxy_args=(--proxy "$YT_DLP_PROXY")

echo "Checking $url"
info=$(yt-dlp --no-warnings "${proxy_args[@]}" -j "$url") || { echo "  not available, skipping"; exit 0; }
is_live=$(echo "$info" | python3 -c "import json,sys; print(json.load(sys.stdin).get('is_live'))")
if [ "$is_live" != "True" ]; then
  echo "  not live, skipping"
  exit 0
fi

echo "  live! recording from start"
read handle date id <<< "$(echo "$info" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['uploader_id'].lstrip('@'), (d.get('release_date') or d['upload_date']), d['id'])
")"
date="${date:0:4}-${date:4:2}-${date:6:2}"
outtmpl="recordings/${handle}-${date}-${id}"

( prev_bytes=0
  while :; do
    sleep 30
    bytes=$(du -cb "${outtmpl}"*.part 2>/dev/null | tail -1 | cut -f1) || true
    if [ -n "$bytes" ]; then
      size=$(numfmt --to=iec --suffix=B "$bytes")
      rate=$(awk -v b="$bytes" -v p="$prev_bytes" 'BEGIN { printf "%.1f", (b-p)/30/1024/1024 }')
      echo "  ...[$(date '+%H:%M:%S')] still recording, $size so far (~${rate} MB/s)"
      prev_bytes=$bytes
    fi
  done ) &
progress_pid=$!
trap 'kill "$progress_pid" 2>/dev/null || true' EXIT

# yt-dlp resumes from existing fragments on the same outtmpl, so a retry
# after a dropped connection continues rather than starting over. But the
# default --skip-unavailable-fragments silently drops content that fails
# 10 retries (the default) instead of erroring, which is how we lost ~10
# minutes out of a recording without the process ever crashing — so make
# fragment retries patient enough that we rarely even reach that point,
# and abort loudly instead of skipping if we ever do.
max_attempts=10
attempt=1
filepath=""
while [ "$attempt" -le "$max_attempts" ]; do
  if filepath=$(yt-dlp "${proxy_args[@]}" --live-from-start \
      --fragment-retries infinite --retry-sleep "fragment:exp=1:60:2" --abort-on-unavailable-fragments \
      -o "${outtmpl}.%(ext)s" --print after_move:filepath "$url" | tail -n1) && [ -n "$filepath" ]; then
    break
  fi
  echo "  recording attempt $attempt/$max_attempts failed, retrying in 10s..."
  attempt=$((attempt + 1))
  sleep 10
done
kill "$progress_pid" 2>/dev/null || true

if [ -z "$filepath" ]; then
  echo "  gave up after $max_attempts attempts"
  exit 1
fi
title=$(basename "$filepath")

if [ -n "$SKIP_UPLOAD" ]; then
  echo "  recorded to $filepath (SKIP_UPLOAD set, not uploading)"
else
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto \
    aws s3 cp "$filepath" "s3://${R2_BUCKET}/${title}" --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
  echo "{\"event_type\":\"recording-ready\",\"client_payload\":{\"key\":\"$title\"}}" \
    | gh api "repos/$GITHUB_REPOSITORY/dispatches" --input -
fi
