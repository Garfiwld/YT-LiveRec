# YT-LiveRec

Records YouTube live streams from a channel list, hands each recording off
via Cloudflare R2, and uploads it to YouTube as a private video.

## How it works

**Detection — two paths, one destination**

- **Webhook (event-driven):** [scripts/subscribe.sh](scripts/subscribe.sh)
  subscribes each channel to YouTube's PubSubHubbub feed, pointed at a
  Cloudflare Worker ([cloudflare-worker/worker.js](cloudflare-worker/worker.js)).
  When a channel publishes/updates a video, YouTube pings the Worker, which
  verifies the request and forwards it to GitHub as a `youtube-live`
  `repository_dispatch` event. [resubscribe.yml](.github/workflows/resubscribe.yml)
  renews these subscriptions every 5 days (they expire after ~10). This
  depends on Google's PubSubHubbub hub (`pubsubhubbub.appspot.com`), which
  is known to return transient (sometimes extended) 503s — the polling
  path below is the fallback for when it's down.
- **Polling:** [poll-live.yml](.github/workflows/poll-live.yml) checks every
  channel's live status directly (no recording, cheap) and dispatches the
  same `youtube-live` event when it finds one live. It has no built-in
  schedule — trigger it manually, or point an external cron service (e.g.
  cron-job.org) at its `workflow_dispatch` API.

Both paths converge on `youtube-live`, which
[notify-live.yml](.github/workflows/notify-live.yml) picks up: it re-checks
the specific video and, if live, records it with
[scripts/check_and_record.sh](scripts/check_and_record.sh) — the same
script a local run uses (see below). `concurrency: group: record-<video_id>`
there means a duplicate dispatch for the same video queues instead of
double-recording.

**Getting past YouTube's datacenter-IP block**
YouTube returns "Sign in to confirm you're not a bot" for some live videos
when yt-dlp runs from GitHub Actions' IPs. `notify-live.yml` and
`poll-live.yml` install Cloudflare WARP on the runner itself and route
yt-dlp through its local SOCKS5 proxy mode (`127.0.0.1:40000`) — no
external machine involved. (We tried Tailscale first: fine for the cheap
`poll-live.yml` checks, but the runner's connection back to a home
machine relayed through a distant DERP server instead of a direct P2P
link — not enough sustained bandwidth for an actual live download, which
failed after ~1h of "Did not get any data blocks". WARP runs entirely on
the runner with the Cloudflare network's own bandwidth, no relay.)

**After a recording lands**
`check_and_record.sh` uploads the file to an R2 bucket with `aws s3 cp`
(R2's S3-compatible API — not `wrangler r2 object put`, which caps uploads
at 300 MiB) and dispatches a `recording-ready` event. That fires
[upload-youtube.yml](.github/workflows/upload-youtube.yml), which
downloads the file, uploads it to YouTube with
[scripts/upload_youtube.py](scripts/upload_youtube.py) as
`privacyStatus: private`, then deletes it from R2 — R2 is only ever a
handoff to get the file off the ephemeral runner, not permanent storage.

**Running locally**
[scripts/run_local.sh](scripts/run_local.sh) reads handles from
`scripts/channels.txt` (one per line, `#` comments allowed) and
checks/records each in parallel — same `check_and_record.sh` logic, but
sets `SKIP_UPLOAD=1` so recordings stay local instead of going to R2.

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

### 3. R2 bucket
```bash
npx wrangler r2 bucket create yt-liverec-recordings
```
Create an **R2 API token** (dash.cloudflare.com → R2 → Manage API Tokens →
Object Read & Write, scoped to this bucket) — distinct from the Cloudflare
account API token above; `aws s3 cp` needs S3-compatible credentials, not
a Cloudflare API token.

### 4. Repo secrets
```bash
gh secret set WORKER_URL              # the deployed Worker's URL
gh secret set WEBHOOK_SECRET          # same value as step 2
gh secret set CLOUDFLARE_ACCOUNT_ID   # for the R2 S3 endpoint URL
gh secret set R2_ACCESS_KEY_ID        # from step 3
gh secret set R2_SECRET_ACCESS_KEY    # from step 3
```

### 5. Subscribe channels to the webhook
```bash
gh variable get CHANNELS | ./scripts/subscribe.sh <worker-url> <webhook-secret>
```

### 6. Nothing to set up here
Cloudflare WARP (used to dodge YouTube's datacenter-IP block, see above)
installs and connects itself inside each workflow run — no secrets, no
external machine. `warp-cli` syntax has moved around between versions;
if a future WARP release breaks the `mode proxy` / `proxy port` commands
in [notify-live.yml](.github/workflows/notify-live.yml) or
[poll-live.yml](.github/workflows/poll-live.yml), run
`warp-cli --accept-tos --help` on a fresh runner to find the current one.

### 7. External polling trigger
```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/poll-live.yml/dispatches
Authorization: Bearer <fine-grained PAT, Actions: read and write, scoped to this repo>
Accept: application/vnd.github+json
Content-Type: application/json

{"ref":"master"}
```
Use a separate PAT from the Worker's — least privilege, independently
revocable. Point an external cron service (e.g. cron-job.org) at this.

### 8. YouTube upload
Requires a Google Cloud project with YouTube Data API v3 enabled and an
OAuth client (Desktop app type). See [site-worker/](site-worker/) and
[PRIVACY.md](PRIVACY.md) if you need to publish the OAuth consent screen
(requires a homepage + privacy policy URL on a domain you can verify in
Google Search Console — `github.com` doesn't qualify since you don't own
it).
```bash
gh secret set YT_CLIENT_ID
gh secret set YT_CLIENT_SECRET
python3 scripts/get_youtube_refresh_token.py <client_id> <client_secret>
```
The last command opens a consent URL, then sets `YT_REFRESH_TOKEN` for you.

**Known limitation:** the app requests the sensitive `youtube.upload`
scope without going through Google's full app verification (a heavyweight
process meant for public multi-user apps, not worth it here). Even
published, refresh tokens for this scope expire after ~7 days — rerun
`get_youtube_refresh_token.py` when uploads start failing. A recurring
reminder for this is set up as a claude.ai routine.
