# YT-LiveRec

Records YouTube live streams from a channel list, hands each recording off
via Cloudflare R2, and uploads it to YouTube as a private video.

## How it works

**Detection — a Cloudflare Worker polls, no webhook**
[cloudflare-worker/worker.js](cloudflare-worker/worker.js) runs on its own
Cron Trigger (every 10 minutes). Each run, it reads the channel list from
its KV namespace and, per channel, fetches `youtube.com/<handle>/live` as
plain HTML — a `<link rel="canonical">` pointing at a real video ID means
that channel is live right now, and this plain fetch isn't behind the
bot-check that gates YouTube's player API, so no proxy/WARP is needed for
detection. When it finds one live, it dispatches a `youtube-live`
`repository_dispatch` event to GitHub with the video ID.

The channel list itself is edited through the same Worker's `/admin` page
(`?token=...`, see setup below) instead of a repo variable or a file —
GET shows the current list in a textarea, POST saves it back to KV.

`notify-live.yml` picks up `youtube-live`: it re-checks the specific video
and, if live, records it with
[scripts/check_and_record.sh](scripts/check_and_record.sh) — the same
script a local run uses (see below). `concurrency: group: record-<video_id>`
there means a duplicate dispatch for the same video queues instead of
double-recording.

**Getting past YouTube's datacenter-IP block**
YouTube returns "Sign in to confirm you're not a bot" for some live videos
when yt-dlp runs from GitHub Actions' IPs — this only bites the actual
recording step, since detection (above) avoids it entirely. `notify-live.yml`
installs Cloudflare WARP on the runner itself and routes yt-dlp through its
local SOCKS5 proxy mode (`127.0.0.1:40000`) — no external machine involved.
(We tried Tailscale first: the runner's connection back to a home machine
relayed through a distant DERP server instead of a direct P2P link — not
enough sustained bandwidth for an actual live download, which failed after
~1h of "Did not get any data blocks". WARP runs entirely on the runner with
the Cloudflare network's own bandwidth, no relay.)

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

### 1. Cloudflare Worker (detection + channel list)
```bash
cd cloudflare-worker
npx wrangler login
npx wrangler kv namespace create CHANNELS_KV   # paste the returned [[kv_namespaces]] block into wrangler.toml
npx wrangler deploy
npx wrangler secret put GH_TOKEN      # fine-grained PAT, Contents: read/write, scoped to this repo only
npx wrangler secret put ADMIN_TOKEN   # any random value — gates the /admin channel-list page
```
Set `GH_REPO` in [wrangler.toml](cloudflare-worker/wrangler.toml) to
`owner/repo`, then `npx wrangler deploy` again.

### 2. Channel list
Not committed to the repo. Set it via the Worker's own admin page:
```
https://<worker-url>/admin?token=<ADMIN_TOKEN from step 1>
```
One handle per line (lines starting with `#` are ignored), e.g. `@MrBeast`.
Or seed it directly: `npx wrangler kv key put --binding=CHANNELS_KV --remote channels --path=channels.txt`.

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
gh secret set CLOUDFLARE_ACCOUNT_ID   # for the R2 S3 endpoint URL
gh secret set R2_ACCESS_KEY_ID        # from step 3
gh secret set R2_SECRET_ACCESS_KEY    # from step 3
```

### 5. Nothing to set up here
Cloudflare WARP (used to dodge YouTube's datacenter-IP block, see above)
installs and connects itself inside each `notify-live.yml` run — no
secrets, no external machine. `warp-cli` syntax has moved around between
versions; if a future WARP release breaks the `mode proxy` / `proxy port`
commands there, run `warp-cli --accept-tos --help` on a fresh runner to
find the current one.

### 6. YouTube upload
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
