const PRIVACY_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Privacy Policy — YT-LiveRec</title></head>
<body style="font-family: sans-serif; max-width: 640px; margin: 40px auto; line-height: 1.6;">
<h1>Privacy Policy</h1>
<p>YT-LiveRec is a personal-use automation tool. It is not a public service and has no other users besides its owner.</p>
<h2>What it accesses</h2>
<p>The tool uses the YouTube Data API v3, authorized via OAuth, solely to upload video recordings to the owner's own YouTube channel as private videos. It requests only the <code>youtube.upload</code> scope.</p>
<h2>Data handling</h2>
<ul>
<li>No data is collected from or shared with any third party.</li>
<li>No data is sold, rented, or used for advertising.</li>
<li>Video files are held temporarily (Cloudflare R2 storage) only until upload to YouTube completes, then deleted.</li>
<li>OAuth credentials are stored as encrypted GitHub Actions secrets and used only by this repository's own automated workflows.</li>
</ul>
<h2>Contact</h2>
<p>Questions about this tool can be opened as an issue on its <a href="https://github.com/Garfiwld/YT-LiveRec">GitHub repository</a>.</p>
</body>
</html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/google6c7bc2b4e4194bbe.html") {
      return new Response("google-site-verification: google6c7bc2b4e4194bbe.html", {
        headers: { "content-type": "text/html" },
      });
    }

    if (url.pathname === "/privacy" || url.pathname === "/privacy.html" || url.pathname === "/") {
      return new Response(PRIVACY_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
