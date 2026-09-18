#!/bin/bash
# Checks whether $1 (a YouTube video or /live URL) is live; if so, records
# it from the start, uploads it to R2, and dispatches a recording-ready
# event for upload-youtube.yml to pick up.
# Set SKIP_UPLOAD=1 to record only, without uploading/dispatching.
set -e
R2_BUCKET="yt-liverec-recordings"
url="$1"

echo "Checking $url"
info=$(yt-dlp --no-warnings -j "$url" 2>/dev/null) || { echo "  not available, skipping"; exit 0; }
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
filepath=$(yt-dlp --live-from-start -o "recordings/${handle}-${date}-${id}.%(ext)s" --print after_move:filepath "$url" | tail -n1)
title=$(basename "$filepath")

if [ -n "$SKIP_UPLOAD" ]; then
  echo "  recorded to $filepath (SKIP_UPLOAD set, not uploading)"
else
  npx wrangler r2 object put "${R2_BUCKET}/${title}" --file="$filepath" --remote
  echo "{\"event_type\":\"recording-ready\",\"client_payload\":{\"key\":\"$title\"}}" \
    | gh api "repos/$GITHUB_REPOSITORY/dispatches" --input -
fi
