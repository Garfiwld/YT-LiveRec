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
filepath=$(yt-dlp "${proxy_args[@]}" --live-from-start -o "recordings/${handle}-${date}-${id}.%(ext)s" --print after_move:filepath "$url" | tail -n1)
title=$(basename "$filepath")

if [ -n "$SKIP_UPLOAD" ]; then
  echo "  recorded to $filepath (SKIP_UPLOAD set, not uploading)"
else
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto \
    aws s3 cp "$filepath" "s3://${R2_BUCKET}/${title}" --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
  echo "{\"event_type\":\"recording-ready\",\"client_payload\":{\"key\":\"$title\"}}" \
    | gh api "repos/$GITHUB_REPOSITORY/dispatches" --input -
fi
