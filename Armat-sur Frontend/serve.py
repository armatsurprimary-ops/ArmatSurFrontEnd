"""Armat-sur local server.

Serves the app at http://localhost:8000 and prints the traffic between the
app and model services: the frontend POSTs each outgoing request and incoming
response to /log, and this window shows the literal message contents as the
game runs (long messages are truncated for readability).

Close this window to stop the server.
"""
import http.server
import http.client
import json
import os
import re
import sys
from datetime import datetime
from urllib.parse import urlparse, parse_qs

HOST = "127.0.0.1"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
TRUNCATE = 3000  # max chars printed per message
SAVES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "saves")


def safe_name(name):
    """Make a session name safe for use as a filename (no traversal, no hostiles)."""
    name = (name or "").strip()
    name = name.replace("..", "").replace("/", "").replace("\\", "")
    name = re.sub(r'[<>:"|?*]', "", name)
    return (name[:60].strip() or "session")


def clip(text):
    text = str(text)
    if len(text) > TRUNCATE:
        return text[:TRUNCATE] + "\n... [truncated, %d chars total]" % len(text)
    return text


def print_request(data):
    tools = data.get("tools") or []
    print("=" * 64)
    print("[%s] REQUEST -> model: %s%s%s" % (
        datetime.now().strftime("%H:%M:%S"),
        data.get("model", "?"),
        " | provider: %s" % data["provider"] if data.get("provider") else "",
        " | tools: %s" % ", ".join(tools) if tools else ""))
    for m in data.get("messages", []):
        print("-- %s --" % m.get("role", "?"))
        content = m.get("content")
        print(clip(content) if content else "(no content)")
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function") or {}
            print("[tool_call] %s(%s)" % (fn.get("name"), clip(fn.get("arguments", ""))))


def print_response(data):
    usage = data.get("usage") or {}
    cost = data.get("cost")
    print("-" * 64)
    print("[%s] RESPONSE  (prompt %s tok, completion %s tok%s)" % (
        datetime.now().strftime("%H:%M:%S"),
        usage.get("prompt_tokens", "?"), usage.get("completion_tokens", "?"),
        ", cost $%.4f" % cost if isinstance(cost, (int, float)) else ""))
    msg = data.get("message") or {}
    if msg.get("reasoning"):
        print("[reasoning]")
        print(clip(msg["reasoning"]))
    if msg.get("content"):
        print(clip(msg["content"]))
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        print("[tool_call] %s(%s)" % (fn.get("name"), clip(fn.get("arguments", ""))))


def print_error(data):
    print("!" * 64)
    print("[%s] ERROR: %s" % (datetime.now().strftime("%H:%M:%S"), data.get("error")))


class Handler(http.server.SimpleHTTPRequestHandler):
    def _abliteration(self, path):
        # Fixed host and exact endpoint allowlist: never an arbitrary URL proxy.
        endpoints = {'/api/abliteration/models': '/v1/models',
                     '/api/abliteration/chat/completions': '/v1/chat/completions'}
        if path not in endpoints:
            return self._send_json(404, {'error': 'unknown API endpoint'})
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or not auth[7:].strip() or len(auth) > 8192:
            return self._send_json(401, {'error': 'Abliteration.ai API key required'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 128 * 1024 * 1024:
                return self._send_json(413, {'error': 'request must be between 1 byte and 128 MiB'})
            raw = self.rfile.read(length)
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError('object required')
        except (ValueError, UnicodeError):
            return self._send_json(400, {'error': 'invalid request JSON'})
        upstream = http.client.HTTPSConnection('api.abliteration.ai', timeout=120)
        started = False
        try:
            is_models = path.endswith('/models')
            upstream.request('GET' if is_models else 'POST', endpoints[path],
                             body=None if is_models else raw,
                             headers={'Authorization': auth, 'Content-Type': 'application/json',
                                      'Accept': 'application/json, text/event-stream'})
            response = upstream.getresponse()
            # http.client does not follow redirects, so credentials cannot move hosts.
            if 300 <= response.status < 400:
                return self._send_json(502, {'error': 'unexpected redirect from Abliteration.ai'})
            self.send_response(response.status)
            self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            started = True
            # read1 forwards available SSE bytes without waiting for a full buffer.
            while True:
                chunk = response.read1(16384)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException):
            # No exception text, headers, or body are logged: they may contain secrets.
            if not started:
                self._send_json(502, {'error': 'could not connect to Abliteration.ai'})
        finally:
            upstream.close()

    def _trusted_host(self):
        port = self.server.server_address[1]
        allowed = {"localhost:%d" % port, "127.0.0.1:%d" % port}
        if port == 80:
            allowed.update({"localhost", "127.0.0.1"})
        return self.headers.get("Host", "").lower() in allowed

    def _allow_write(self):
        # A custom header + JSON prevent simple cross-site form/fetch writes.
        # No CORS preflight is enabled. Origin/Host checks also reject rebinding.
        origin = self.headers.get("Origin")
        expected = "http://" + self.headers.get("Host", "").lower()
        if (not self._trusted_host() or
                (origin is not None and origin.lower() != expected) or
                self.headers.get("Sec-Fetch-Site") == "cross-site" or
                self.headers.get("X-ArmatSur-Request") != "1"):
            self._send_json(403, {"error": "untrusted request"})
            return False
        if self.headers.get_content_type() != "application/json":
            self._send_json(415, {"error": "application/json required"})
            return False
        return True

    def log_message(self, *args):
        pass  # static-file requests stay quiet

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _list_sessions(self):
        entries = []
        if os.path.isdir(SAVES_DIR):
            for fn in os.listdir(SAVES_DIR):
                if not fn.endswith(".json"):
                    continue
                full = os.path.join(SAVES_DIR, fn)
                saved_at = None
                try:
                    with open(full, "r", encoding="utf-8") as f:
                        saved_at = (json.load(f).get("meta") or {}).get("savedAt")
                except Exception:
                    pass
                entries.append({
                    "name": fn[:-5],
                    "savedAt": saved_at,
                    "fileSavedAt": os.path.getmtime(full) * 1000,
                    "size": os.path.getsize(full)
                })
        entries.sort(key=lambda e: e["fileSavedAt"], reverse=True)
        return entries

    def do_GET(self):
        if not self._trusted_host():
            return self._send_json(403, {"error": "untrusted host"})
        parsed = urlparse(self.path)
        if parsed.path == "/sessions":
            return self._send_json(200, {"sessions": self._list_sessions()})
        if parsed.path == "/load":
            name = safe_name((parse_qs(parsed.query).get("name") or [""])[0])
            full = os.path.join(SAVES_DIR, name + ".json")
            if not os.path.isfile(full):
                return self._send_json(404, {"error": "no save named '%s'" % name})
            with open(full, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def do_POST(self):
        if not self._allow_write():
            return
        parsed = urlparse(self.path)
        if parsed.path.startswith('/api/abliteration'):
            if parsed.query:
                return self._send_json(400, {'error': 'query parameters are not accepted'})
            return self._abliteration(parsed.path)
        if parsed.path == "/delete":
            names = parse_qs(parsed.query, keep_blank_values=True).get("name", [])
            # Deletion must target the exact listed filename, never a sanitized
            # alias or a default name. Resolve containment before touching disk.
            if (len(names) != 1 or not names[0] or names[0] != safe_name(names[0]) or
                    any(ord(c) < 32 for c in names[0])):
                return self._send_json(400, {"error": "invalid session name"})
            name = names[0]
            root = os.path.realpath(SAVES_DIR)
            full = os.path.join(root, name + ".json")
            if (os.path.commonpath([root, os.path.realpath(full)]) != root or
                    os.path.islink(full)):
                return self._send_json(400, {"error": "invalid session path"})
            try:
                if not os.path.isfile(full):
                    return self._send_json(404, {"error": "saved session no longer exists"})
                os.unlink(full)
            except FileNotFoundError:
                return self._send_json(404, {"error": "saved session no longer exists"})
            except OSError:
                return self._send_json(500, {"error": "could not delete saved session"})
            return self._send_json(200, {"deleted": name})
        if parsed.path == "/save":
            name = safe_name((parse_qs(parsed.query).get("name") or [""])[0])
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw or b"{}")
                if not isinstance(data, dict) or "branches" not in data or "messages" not in data:
                    raise ValueError("missing branches/messages")
            except Exception as e:
                return self._send_json(400, {"error": "invalid session json: %s" % e})
            os.makedirs(SAVES_DIR, exist_ok=True)
            with open(os.path.join(SAVES_DIR, name + ".json"), "w", encoding="utf-8") as f:
                f.write(raw.decode("utf-8"))
            print("[save] session '%s' -> saves/%s.json (%d bytes)" % (name, name, len(raw)))
            return self._send_json(200, {"saved": name})
        if parsed.path != "/log":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length) or b"{}")
            kind = data.get("kind")
            if kind == "request":
                print_request(data)
            elif kind == "response":
                print_response(data)
            elif kind == "error":
                print_error(data)
            else:
                print("[?] unknown log payload: %s" % clip(json.dumps(data)))
            self.send_response(204)
            self.end_headers()
        except Exception as e:
            self.send_response(400)
            self.end_headers()
            print("bad /log payload: %s" % e)


if __name__ == "__main__":
    print("Armat-sur server running at http://localhost:%d" % PORT)
    print("Session saves go to: %s" % SAVES_DIR)
    print("Model traffic will be printed below as the game runs.")
    print("Close this window to stop the server.\n")
    http.server.ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
