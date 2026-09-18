# YT-LiveRec

Records YouTube live streams from a channel list, hands each recording off
via a (temporary) GitHub Release, and uploads it to YouTube as a private
video.

## How it works

**Detection — two paths, one destination**

- **Webhook (event-driven):** [scripts/subscribe.sh](scripts/subscribe.sh)
  subscribes each channel to YouTube's PubSubHubbub feed, pointed at a
  Cloudflare Worker ([cloudflare-worker/worker.js](cloudflare-worker/worker.js)).
  When a channel publishes/updates a video, YouTube pings the Worker, which
  verifies the request and forwards it to GitHub as a `repository_dispatch`
  event. [resubscribe.yml](.github/workflows/resubscribe.yml) renews these
  subscriptions every 5 days (they expire after ~10). This depends on
  Google's PubSubHubbub hub (`pubsubhubbub.appspot.com`), which is known to
  return transient (sometimes extended) 503s — see the polling path below
  for when it's down.
- **Polling:** [poll-live.yml](.github/workflows/poll-live.yml) checks every
  channel's live status directly (no recording, cheap) and dispatches the
  same event as the webhook when it finds one live. It's triggered by
  `workflow_dispatch` — either manually, or on a schedule via an external
  cron service (e.g. cron-job.org) calling its `/dispatches` API, since
  GitHub's own `schedule:` trigger was dropped in favor of that.

Both paths converge on the same `youtube-live` `repository_dispatch` event,
which [notify-live.yml](.github/workflows/notify-live.yml) picks up: it
re-checks the specific video and, if live, records it with
[scripts/check_and_record.sh](scripts/check_and_record.sh) — the same script
a local run uses (see below) — and publishes it as a GitHub Release.
`concurrency: group: record-<video_id>` there means a duplicate dispatch for
the same video queues instead of double-recording.

**After a recording lands**
A new GitHub Release fires [upload-youtube.yml](.github/workflows/upload-youtube.yml),
which downloads the asset, uploads it to YouTube with
[scripts/upload_youtube.py](scripts/upload_youtube.py) as `privacyStatus: private`,
then deletes the Release (and its tag) — it was only ever a handoff to get
the file off the runner, not permanent storage.

**Running locally**
[scripts/run_local.sh](scripts/run_local.sh) reads handles from
`scripts/channels.txt` (one per line, `#` comments allowed) and
checks/records each in parallel — same `check_and_record.sh` logic, but
sets `SKIP_RELEASE=1` so recordings stay local instead of becoming a
GitHub Release.

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

### 5. External polling schedule
`poll-live.yml` has no built-in schedule — point an external cron service
(e.g. [cron-job.org](https://cron-job.org)) at its dispatch API:
```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/poll-live.yml/dispatches
Authorization: Bearer <fine-grained PAT, Actions: read and write, scoped to this repo>
Accept: application/vnd.github+json
Content-Type: application/json

{"ref":"master"}
```
Use a separate PAT from the Worker's — least privilege, independently
revocable.

### 6. (Optional) YouTube upload
Requires OAuth credentials from Google Cloud Console (YouTube Data API v3
enabled):
```bash
gh secret set YT_CLIENT_ID
gh secret set YT_CLIENT_SECRET
gh secret set YT_REFRESH_TOKEN
```
