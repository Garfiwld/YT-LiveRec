#!/bin/bash
# Checks whether $1 (a YouTube video or /live URL) is live; if so, records
# it from the start and publishes it as a GitHub Release.
set -e
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
tag="rec-${GITHUB_RUN_ID}-$(echo "$title" | md5sum | cut -c1-6)"
gh release create "$tag" "$filepath" --title "$title" --notes "Recorded from $url"
