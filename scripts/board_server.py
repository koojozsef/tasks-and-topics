#!/usr/bin/env python3
"""Local-only stdlib HTTP server for `tt board` — serves the static planner
page and a small JSON API backed by scripts/board_lib.py.

No third-party dependencies (see docs/visual-planner-plan.md §6): the
frontend is hand-rolled SVG/vanilla JS rather than a vendored graph
library, since this environment has no outbound access to fetch one, and
it keeps the tool genuinely dependency-free either way.
"""

import json
import socketserver
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import board_lib  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = REPO_ROOT / "static"

STATIC_FILES = {
    "/": (STATIC_DIR / "board.html", "text/html; charset=utf-8"),
    "/board.js": (STATIC_DIR / "board.js", "application/javascript; charset=utf-8"),
    "/board.css": (STATIC_DIR / "board.css", "text/css; charset=utf-8"),
}


def make_handler(board_path, notes_root):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ttboard/1.0"

        def log_message(self, fmt, *args):
            pass  # keep terminal quiet; errors still surface via HTTP responses

        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_static(self, path, content_type):
            if not path.exists():
                self.send_error(404, "Not found")
                return
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _board_state(self):
            tasks = board_lib.load(board_path)
            topics = []
            seen = set()
            for t in tasks:
                label = t["topic"] or board_lib.NO_TOPIC
                if label not in seen:
                    seen.add(label)
                    topics.append(label)
            return {"tasks": board_lib.to_json(tasks), "topics": topics}

        def _read_json_body(self):
            length = int(self.headers.get("Content-Length", 0))
            if length == 0:
                return {}
            raw = self.rfile.read(length)
            try:
                return json.loads(raw or b"{}")
            except json.JSONDecodeError:
                raise board_lib.BoardError("Malformed JSON request body")

        def do_GET(self):
            if self.path == "/api/board":
                self._send_json(200, self._board_state())
                return
            entry = STATIC_FILES.get(self.path)
            if entry:
                self._send_static(*entry)
                return
            self.send_error(404, "Not found")

        def do_POST(self):
            if not self.path.startswith("/api/board/"):
                self.send_error(404, "Not found")
                return
            action = self.path[len("/api/board/"):]
            try:
                body = self._read_json_body()
                tasks = board_lib.load(board_path)

                if action == "add":
                    board_lib.add_task(tasks, body.get("text", ""), topic=body.get("topic"))
                elif action == "link":
                    board_lib.link(tasks, body["pred"], body["succ"])
                elif action == "unlink":
                    board_lib.unlink(tasks, body["pred"], body["succ"])
                elif action == "done":
                    board_lib.set_done(tasks, body["id"], bool(body.get("done", True)))
                elif action == "rename":
                    board_lib.rename(tasks, body["id"], body.get("text", ""))
                elif action == "delete":
                    board_lib.delete_task(tasks, body["id"], bridge=bool(body.get("bridge", True)))
                elif action == "splice":
                    board_lib.splice(
                        tasks,
                        body["pred"],
                        body["succ"],
                        body.get("text", ""),
                        topic=body.get("topic"),
                    )
                elif action == "import":
                    board_lib.import_all(
                        notes_root,
                        board_path,
                        topics_only=bool(body.get("topics_only", False)),
                        skip_done=bool(body.get("skip_done", False)),
                    )
                    tasks = board_lib.load(board_path)
                else:
                    self.send_error(404, "Unknown action")
                    return

                if action != "import":
                    board_lib.save(board_path, tasks)
                self._send_json(200, self._board_state())
            except board_lib.BoardError as e:
                self._send_json(400, {"error": str(e)})
            except KeyError as e:
                self._send_json(400, {"error": f"Missing field: {e}"})

    return Handler


def serve(notes_root, board_path, port=0):
    handler = make_handler(board_path, notes_root)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    return httpd


def main():
    import argparse

    parser = argparse.ArgumentParser(prog="board_server.py")
    parser.add_argument("--root", default=".", help="notes repo root")
    parser.add_argument("--board", default=None, help="path to board.md")
    parser.add_argument("--port", type=int, default=0, help="port (0 = pick a free one)")
    args = parser.parse_args()

    notes_root = Path(args.root).resolve()
    board_path = Path(args.board).resolve() if args.board else notes_root / "board.md"
    if not board_path.exists():
        board_lib.save(board_path, [])

    httpd = serve(notes_root, board_path, args.port)
    host, port = httpd.server_address
    print(f"http://127.0.0.1:{port}")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
