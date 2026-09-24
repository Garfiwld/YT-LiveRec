// Polls each channel's /live page on a Cron Trigger (see wrangler.toml) and
// dispatches a repository_dispatch("youtube-live") to GitHub when one is
// actually live — same event notify-live.yml already consumes. Detection
// works by browser-fetching the /live page: YouTube's <link rel="canonical">
// resolves to the live video's own watch URL only while a broadcast is
// actually live, and is the literal string "undefined" otherwise. No
// yt-dlp, no proxy — a plain page fetch isn't behind the bot-check that
// gates the player API (that's what needed WARP for the actual recording).
//
// The channel list lives in KV (not a secret) so the /admin page below can
// edit it. GET /admin?token=... to view/edit; POST there to save.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/admin") return handleAdmin(request, env);
    return new Response("ok");
  },

  async scheduled(event, env, ctx) {
    const handles = await getChannels(env);
    await Promise.all(handles.map((handle) => checkAndDispatch(handle, env)));
  },
};

async function getChannels(env) {
  const raw = (await env.CHANNELS_KV.get("channels")) || "";
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

async function handleAdmin(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== env.ADMIN_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }

  if (request.method === "POST") {
    const form = await request.formData();
    await env.CHANNELS_KV.put("channels", form.get("channels") || "");
    return Response.redirect(url.toString(), 303);
  }

  const current = (await env.CHANNELS_KV.get("channels")) || "";
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>YT-LiveRec channels</title></head>
<body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;">
<h1>Channels to watch</h1>
<form method="POST">
<textarea name="channels" rows="15" style="width: 100%; font-family: monospace;">${escapeHtml(current)}</textarea>
<p><button type="submit">Save</button></p>
</form>
<p style="color: #666;">One @handle per line. Lines starting with # are ignored.</p>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function checkAndDispatch(handle, env) {
  const res = await fetch(`https://www.youtube.com/${handle}/live`, {
    headers: { "User-Agent": BROWSER_UA },
  });
  const html = await res.text();

  const match = html.match(/rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([^"]+)"/);
  if (!match) return;

  const videoId = match[1];
  await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "yt-live-notify-worker",
    },
    body: JSON.stringify({
      event_type: "youtube-live",
      client_payload: { video_id: videoId },
    }),
  });
}
