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
// edit it, guarded by a passkey login instead of a bare shared token. The
// shared ADMIN_TOKEN secret still gates /admin/register — the one-time,
// per-device bootstrap step that creates the passkey in the first place.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const SIMPLEWEBAUTHN_BROWSER_SRC =
  "https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@14.0.0/dist/bundle/index.umd.min.js";
const SESSION_COOKIE = "yt_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_TTL_SECONDS = 300;
const CREDENTIAL_KEY = "webauthn:credential";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const routes = {
      "/admin": handleAdmin,
      "/admin/register": handleRegisterPage,
      "/admin/register/options": handleRegisterOptions,
      "/admin/register/verify": handleRegisterVerify,
      "/admin/login/options": handleLoginOptions,
      "/admin/login/verify": handleLoginVerify,
      "/admin/check-now": handleCheckNow,
    };
    const handler = routes[url.pathname];
    if (!handler) return new Response("ok");
    try {
      return await handler(request, env, url);
    } catch (err) {
      return new Response(`error: ${err.message}`, { status: 400 });
    }
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

// ---------- base64url + session cookie helpers ----------

function bufToB64Url(buf) {
  let bin = "";
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64UrlToBuf(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function makeSessionCookie(env) {
  const exp = String(Date.now() + SESSION_TTL_SECONDS * 1000);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.ADMIN_TOKEN), new TextEncoder().encode(exp));
  return `${SESSION_COOKIE}=${exp}.${bufToB64Url(sig)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

async function hasValidSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;
  const [expStr, sig] = match[1].split(".");
  if (!expStr || !sig || Number(expStr) < Date.now()) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(env.ADMIN_TOKEN), b64UrlToBuf(sig), new TextEncoder().encode(expStr));
}

function rpAndOrigin(url) {
  return { rpID: url.hostname, origin: url.origin };
}

// ---------- admin channel page (passkey-gated) ----------

async function handleAdmin(request, env) {
  if (!(await hasValidSession(request, env))) {
    return new Response(loginPageHtml(), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (request.method === "POST") {
    const form = await request.formData();
    await env.CHANNELS_KV.put("channels", form.get("channels") || "");
    return Response.redirect(new URL("/admin", request.url).toString(), 303);
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
<hr>
<button id="check-now">Check for live now</button>
<p id="check-status" style="color: #666;"></p>
<script>
document.getElementById('check-now').addEventListener('click', async () => {
  const status = document.getElementById('check-status');
  status.textContent = 'checking...';
  const res = await fetch('/admin/check-now', { method: 'POST' });
  if (!res.ok) { status.textContent = await res.text(); return; }
  const result = await res.json();
  status.textContent = result.live.length
    ? 'live now: ' + result.live.map((r) => r.handle).join(', ')
    : 'checked ' + result.checked + ' channel(s), none live';
});
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleCheckNow(request, env) {
  if (!(await hasValidSession(request, env))) return new Response("unauthorized", { status: 401 });
  const handles = await getChannels(env);
  const results = await Promise.all(
    handles.map(async (handle) => ({ handle, videoId: await checkAndDispatch(handle, env) }))
  );
  return new Response(JSON.stringify({ checked: handles.length, live: results.filter((r) => r.videoId) }), {
    headers: { "content-type": "application/json" },
  });
}

function loginPageHtml() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>YT-LiveRec admin login</title></head>
<body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;">
<h1>Sign in</h1>
<button id="login">Sign in with passkey</button>
<p id="status" style="color: #666;"></p>
<script src="${SIMPLEWEBAUTHN_BROWSER_SRC}"></script>
<script>
document.getElementById('login').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'requesting challenge...';
  const optsRes = await fetch('/admin/login/options');
  if (!optsRes.ok) { status.textContent = await optsRes.text(); return; }
  const options = await optsRes.json();
  let asseResp;
  try {
    asseResp = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
  } catch (err) {
    status.textContent = 'error: ' + err.message;
    return;
  }
  status.textContent = 'verifying...';
  const verifyRes = await fetch('/admin/login/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(asseResp),
  });
  if (verifyRes.ok) {
    location.reload();
  } else {
    status.textContent = await verifyRes.text();
  }
});
</script>
</body>
</html>`;
}

// ---------- registration (one-time per device, token-gated) ----------

async function handleRegisterPage(request, env, url) {
  const token = url.searchParams.get("token");
  if (token !== env.ADMIN_TOKEN) return new Response("forbidden", { status: 403 });
  return new Response(registerPageHtml(token), { headers: { "content-type": "text/html; charset=utf-8" } });
}

function registerPageHtml(token) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Register passkey</title></head>
<body style="font-family: sans-serif; max-width: 480px; margin: 40px auto;">
<h1>Register a passkey</h1>
<p style="color: #666;">Registering again replaces the previous passkey — only one is kept.</p>
<button id="register">Register this device</button>
<p id="status" style="color: #666;"></p>
<script src="${SIMPLEWEBAUTHN_BROWSER_SRC}"></script>
<script>
const token = ${JSON.stringify(token)};
document.getElementById('register').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'requesting challenge...';
  const optsRes = await fetch('/admin/register/options?token=' + encodeURIComponent(token));
  if (!optsRes.ok) { status.textContent = await optsRes.text(); return; }
  const options = await optsRes.json();
  let attResp;
  try {
    attResp = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
  } catch (err) {
    status.textContent = 'error: ' + err.message;
    return;
  }
  status.textContent = 'verifying...';
  const verifyRes = await fetch('/admin/register/verify?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(attResp),
  });
  status.textContent = verifyRes.ok ? 'registered! go to /admin' : await verifyRes.text();
});
</script>
</body>
</html>`;
}

async function handleRegisterOptions(request, env, url) {
  if (url.searchParams.get("token") !== env.ADMIN_TOKEN) return new Response("forbidden", { status: 403 });
  const { rpID } = rpAndOrigin(url);
  const options = await generateRegistrationOptions({
    rpName: "YT-LiveRec Admin",
    rpID,
    userName: "admin",
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  await env.CHANNELS_KV.put("webauthn:challenge:register", options.challenge, { expirationTtl: CHALLENGE_TTL_SECONDS });
  return new Response(JSON.stringify(options), { headers: { "content-type": "application/json" } });
}

async function handleRegisterVerify(request, env, url) {
  if (url.searchParams.get("token") !== env.ADMIN_TOKEN) return new Response("forbidden", { status: 403 });
  const expectedChallenge = await env.CHANNELS_KV.get("webauthn:challenge:register");
  if (!expectedChallenge) return new Response("challenge expired, try again", { status: 400 });

  const response = await request.json();
  const { rpID, origin } = rpAndOrigin(url);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
  if (!verification.verified) return new Response("not verified", { status: 400 });

  const { credential } = verification.registrationInfo;
  await env.CHANNELS_KV.put(
    CREDENTIAL_KEY,
    JSON.stringify({
      id: credential.id,
      publicKey: bufToB64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || [],
    })
  );
  await env.CHANNELS_KV.delete("webauthn:challenge:register");
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}

// ---------- login ----------

async function loadCredential(env) {
  const raw = await env.CHANNELS_KV.get(CREDENTIAL_KEY);
  if (!raw) return null;
  const c = JSON.parse(raw);
  return { id: c.id, publicKey: b64UrlToBuf(c.publicKey), counter: c.counter, transports: c.transports };
}

async function handleLoginOptions(request, env, url) {
  const credential = await loadCredential(env);
  if (!credential) return new Response("no passkey registered yet", { status: 400 });
  const { rpID } = rpAndOrigin(url);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: [{ id: credential.id, transports: credential.transports }],
    userVerification: "preferred",
  });
  await env.CHANNELS_KV.put("webauthn:challenge:login", options.challenge, { expirationTtl: CHALLENGE_TTL_SECONDS });
  return new Response(JSON.stringify(options), { headers: { "content-type": "application/json" } });
}

async function handleLoginVerify(request, env, url) {
  const credential = await loadCredential(env);
  if (!credential) return new Response("no passkey registered yet", { status: 400 });
  const expectedChallenge = await env.CHANNELS_KV.get("webauthn:challenge:login");
  if (!expectedChallenge) return new Response("challenge expired, try again", { status: 400 });

  const response = await request.json();
  const { rpID, origin } = rpAndOrigin(url);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
  });
  if (!verification.verified) return new Response("not verified", { status: 400 });

  await env.CHANNELS_KV.delete("webauthn:challenge:login");
  await env.CHANNELS_KV.put(
    CREDENTIAL_KEY,
    JSON.stringify({
      id: credential.id,
      publicKey: bufToB64Url(credential.publicKey),
      counter: verification.authenticationInfo.newCounter,
      transports: credential.transports,
    })
  );

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "Set-Cookie": await makeSessionCookie(env) },
  });
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
  if (!match) return null;

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
  return videoId;
}
