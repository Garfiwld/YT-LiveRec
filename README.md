# YT-LiveRec

Records YouTube live streams from a channel list, publishes each recording
as a GitHub Release, and uploads it to YouTube as a private video.

## How it works

**Trigger 1 — manual**
Run [record-live.yml](.github/workflows/record-live.yml). It reads the
channel list from the `CHANNELS` repo variable, checks each channel in
parallel (one job per channel), and records with `yt-dlp --live-from-start`
if it's live.

**Trigger 2 — webhook (automatic)**
[scripts/subscribe.sh](scripts/subscribe.sh) subscribes each channel to
YouTube's PubSubHubbub feed, pointed at a Cloudflare Worker
([cloudflare-worker/worker.js](cloudflare-worker/worker.js)). When a channel
publishes/updates a video, YouTube pings the Worker, which verifies the
request and forwards it to GitHub as a `repository_dispatch` event, firing
[notify-live.yml](.github/workflows/notify-live.yml) for that one video.
[resubscribe.yml](.github/workflows/resubscribe.yml) renews these
subscriptions every 5 days (they expire after ~10).

Both trigger paths share the same check-and-record logic:
[scripts/check_and_record.sh](scripts/check_and_record.sh).

**After a recording lands**
A new GitHub Release fires [upload-youtube.yml](.github/workflows/upload-youtube.yml),
which downloads the asset and uploads it to YouTube with
[scripts/upload_youtube.py](scripts/upload_youtube.py) as `privacyStatus: private`.

## Setup

### 1. Channel list
Not committed to the repo. Set it directly as a repo variable, one handle
per line (lines starting with `#` are ignored):
```bash
gh variable set CHANNELS <<'EOF'
@MrBeast
@NASA
EOF
```

### 2. Cloudflare Worker (webhook relay)
```bash
cd cloudflare-worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put GH_TOKEN        # fine-grained PAT, Contents: read/write, scoped to this repo only
npx wrangler secret put WEBHOOK_SECRET  # any random value; must match the repo secret below
```
Set `GH_REPO` in [wrangler.toml](cloudflare-worker/wrangler.toml) to
`owner/repo`, then `npx wrangler deploy` again.

### 3. Repo secrets
```bash
gh secret set WORKER_URL      # the deployed Worker's URL
gh secret set WEBHOOK_SECRET  # same value as step 2
```

### 4. Subscribe channels to the webhook
```bash
gh variable get CHANNELS | ./scripts/subscribe.sh <worker-url> <webhook-secret>
```

### 5. (Optional) YouTube upload
Requires OAuth credentials from Google Cloud Console (YouTube Data API v3
enabled):
```bash
gh secret set YT_CLIENT_ID
gh secret set YT_CLIENT_SECRET
gh secret set YT_REFRESH_TOKEN
```

## Notes

- The webhook path depends on Google's PubSubHubbub hub
  (`pubsubhubbub.appspot.com`), which occasionally returns transient 503s.
  The manual trigger and `resubscribe.yml`'s periodic renewal are the
  fallback if it's ever down for a while.
- `record` jobs are keyed by `concurrency: record-<handle>` (or `<video_id>`
  for the webhook path) so re-triggering while a channel is already being
  recorded queues instead of double-recording.
