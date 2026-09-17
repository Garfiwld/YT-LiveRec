// Receives YouTube PubSubHubbub (WebSub) notifications and forwards them
// to GitHub as a repository_dispatch event, which triggers notify-live.yml
// to check the video and record it if it's live.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      // WebSub subscription verification handshake.
      const challenge = url.searchParams.get("hub.challenge");
      if (challenge) return new Response(challenge, { status: 200 });
      return new Response("ok");
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const body = await request.text();

    if (!(await validSignature(body, request.headers.get("X-Hub-Signature"), env.WEBHOOK_SECRET))) {
      return new Response("bad signature", { status: 403 });
    }

    const videoId = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!videoId) return new Response("no video id", { status: 400 });

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

    return new Response("ok");
  },
};

async function validSignature(body, header, secret) {
  if (!header || !secret) return false;
  const [algo, hex] = header.split("=");
  const hashAlgo = { sha1: "SHA-1", sha256: "SHA-256" }[algo];
  if (!hashAlgo || !hex) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: hashAlgo },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const macHex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return macHex === hex;
}
