#!/bin/bash
# One-time (repeat every ~10 days — subscriptions expire) setup: subscribes
# every channel (one handle per line, read from stdin) to YouTube's
# PubSubHubbub feed, pointed at the deployed Cloudflare Worker.
#
# Usage: ./subscribe.sh <worker-callback-url> <webhook-secret> < channels.txt
#    or: echo "$CHANNELS" | ./subscribe.sh <worker-callback-url> <webhook-secret>
set -e
callback="$1"
secret="$2"

if [ -z "$callback" ] || [ -z "$secret" ]; then
  echo "Usage: $0 <worker-callback-url> <webhook-secret>" >&2
  exit 1
fi

while IFS= read -r handle; do
  [ -z "$handle" ] && continue
  case "$handle" in \#*) continue ;; esac

  info=$(yt-dlp --no-warnings --flat-playlist --playlist-items 1 -J "https://www.youtube.com/${handle}" 2>/dev/null) || { echo "$handle: couldn't resolve channel_id, skipping"; continue; }
  channel_id=$(echo "$info" | python3 -c "import json,sys; print(json.load(sys.stdin)['channel_id'])")

  echo "Subscribing $handle ($channel_id)"
  # ponytail: fixed 3-try/30s backoff for the hub's own transient 503s, not a general retry framework
  for attempt in 1 2 3; do
    code=$(curl -s -o /dev/null -w "%{http_code}" https://pubsubhubbub.appspot.com/subscribe \
      --data-urlencode "hub.mode=subscribe" \
      --data-urlencode "hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channel_id}" \
      --data-urlencode "hub.callback=${callback}" \
      --data-urlencode "hub.secret=${secret}" \
      --data-urlencode "hub.verify=async")
    if [ "$code" = "202" ] || [ "$code" = "204" ]; then
      echo "  hub responded: $code"
      break
    fi
    echo "  hub responded: $code (attempt $attempt/3)"
    [ "$attempt" -lt 3 ] && sleep 30
  done
done
