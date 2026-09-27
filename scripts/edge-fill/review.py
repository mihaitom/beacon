"""Every cached Fanart.tv background's continued edge, on one page.

    python3 scripts/edge-fill/review.py        # then open http://localhost:9199

Shows each sampled photo with its left edge continued the way
DetailPageBackdrop.vue continues it, in both page framings - so a change to
the continuation can be looked at across all the photos at once rather than
on the one that looked wrong. Needs scripts/edge-fill/.cache/samples.json
(sample.mjs).

Each tile can be labelled continue / fade / unsure, as a note for the next
look; the labels are kept in .cache/labels.json, next to the samples.
"""

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DATA_DIR = Path(os.environ.get("CONNECT_DATA_DIR") or ROOT / "connect")
SAMPLES = HERE / ".cache" / "samples.json"
LABELS_FILE = HERE / ".cache" / "labels.json"
PORT = int(os.environ.get("PORT", "9199"))
LABELS = {"continue", "fade", "unsure"}

SAMPLES_BY_KEY = {f"{s['id']}|{s['frame']}": s for s in json.loads(SAMPLES.read_text())["samples"]}
LABELLED = json.loads(LABELS_FILE.read_text()) if LABELS_FILE.exists() else {}
PAGE = (HERE / "review.html").read_text()


def save():
    tmp = LABELS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(LABELLED, indent=1, sort_keys=True) + "\n")
    tmp.replace(LABELS_FILE)


def items():
    return [
        {
            "id": sample["id"],
            "frame": sample["frame"],
            "gradient": sample.get("gradient"),
            "flat": sample.get("flat"),
            "label": LABELLED.get(key, {}).get("label"),
        }
        for key, sample in sorted(SAMPLES_BY_KEY.items())
    ]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            self.send(200, PAGE.encode(), "text/html; charset=utf-8")
        elif path == "/api/items":
            self.send(200, json.dumps(items()).encode(), "application/json")
        elif match := re.fullmatch(r"/img/([0-9a-f]{64})", path):
            image = DATA_DIR / "fanart_images" / match[1]
            if image.exists():
                self.send(200, image.read_bytes(), "image/jpeg")
            else:
                self.send(404, b"", "text/plain")
        else:
            self.send(404, b"", "text/plain")

    def do_POST(self):
        if self.path != "/api/label":
            self.send(404, b"", "text/plain")
            return
        update = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        key = f"{update['id']}|{update['frame']}"
        if key not in SAMPLES_BY_KEY or update["label"] not in LABELS:
            self.send(400, b"", "text/plain")
            return
        LABELLED[key] = {"label": update["label"], "by": "user"}
        save()
        self.send(204, b"", "text/plain")


if __name__ == "__main__":
    print(f"http://localhost:{PORT}", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
