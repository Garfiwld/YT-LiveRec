#!/usr/bin/env python3
"""Get a fresh YouTube upload refresh token and store it as the
YT_REFRESH_TOKEN GitHub secret. The OAuth app requests the sensitive
youtube.upload scope without full Google verification, so tokens expire
after ~7 days — rerun this whenever uploads start failing with an
invalid_grant error.

Usage: python3 get_youtube_refresh_token.py <client_id> <client_secret>
"""
import http.server
import json
import subprocess
import sys
import urllib.parse
import urllib.request

CLIENT_ID = sys.argv[1]
CLIENT_SECRET = sys.argv[2]
PORT = 8765
REDIRECT_URI = f"http://localhost:{PORT}"

auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
    "client_id": CLIENT_ID,
    "redirect_uri": REDIRECT_URI,
    "response_type": "code",
    "scope": "https://www.googleapis.com/auth/youtube.upload",
    "access_type": "offline",
    "prompt": "consent",
})

print("OPEN_THIS_URL: " + auth_url, flush=True)

code_holder = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        qs = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        if "code" in params:
            code_holder["code"] = params["code"][0]
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h1>Done! You can close this tab.</h1>")
        else:
            self.send_response(400)
            self.end_headers()

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(("localhost", PORT), Handler)
while "code" not in code_holder:
    server.handle_request()

data = urllib.parse.urlencode({
    "code": code_holder["code"],
    "client_id": CLIENT_ID,
    "client_secret": CLIENT_SECRET,
    "redirect_uri": REDIRECT_URI,
    "grant_type": "authorization_code",
}).encode()

req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
with urllib.request.urlopen(req) as resp:
    tokens = json.loads(resp.read())

subprocess.run(
    ["gh", "secret", "set", "YT_REFRESH_TOKEN"],
    input=tokens["refresh_token"],
    text=True,
    check=True,
)
print("YT_REFRESH_TOKEN secret updated.", flush=True)
