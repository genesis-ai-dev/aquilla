"""Unprivileged signed webhook ingress. No Docker or GitHub credentials."""
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = "genesis-ai-dev/aquilla"
REPO_ID = 1210631685
STATE = Path(os.environ.get("QA_STATE", "/var/lib/aquilla-qa"))
# release/YYYY/MM/DD-NN — the branch the deploy bot pushes, and the branch a
# person piles ready pull requests onto. Nothing else starts a run.
RELEASE_REF = re.compile(r"release/\d{4}/\d{2}/\d{2}-\d{2}\Z")


def valid_signature(body, signature, secret):
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return isinstance(signature, str) and hmac.compare_digest(expected, signature)


def parse_event(event, payload):
    # Pull requests do not run. Smart Jev runs the release HEAD people are
    # about to deploy, after any pile-on onto that branch.
    if event != "push":
        return None
    if payload.get("repository", {}).get("id") != REPO_ID:
        raise ValueError("Unexpected repository")
    ref = payload.get("ref") or ""
    if not ref.startswith("refs/heads/"):
        return None
    branch = ref.removeprefix("refs/heads/")
    if not RELEASE_REF.fullmatch(branch):
        return None
    if payload.get("deleted"):
        return None
    sha = payload.get("after")
    if sha == "0" * 40:
        return None
    if not re.fullmatch(r"[a-f0-9]{40}", sha or ""):
        raise ValueError("Invalid release identity")
    return branch, sha


def database():
    db = sqlite3.connect(STATE / "queue.sqlite", timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, pr INTEGER NOT NULL, sha TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', created REAL NOT NULL,
        updated REAL NOT NULL, UNIQUE(pr, sha))""")
    columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
    if "ref" not in columns:
        db.execute("ALTER TABLE jobs ADD COLUMN ref TEXT NOT NULL DEFAULT ''")
    db.commit()
    return db


def enqueue(ref, sha):
    if not RELEASE_REF.fullmatch(ref or ""):
        raise ValueError("Invalid release ref")
    with database() as db:
        # pr stays 0. The unique key is still (pr, sha): one run per commit.
        exists = db.execute("SELECT id FROM jobs WHERE pr=? AND sha=?", (0, sha)).fetchone()
        if exists:
            return "duplicate"
        if db.execute("SELECT COUNT(*) FROM jobs WHERE status='queued'").fetchone()[0] >= 100:
            raise OverflowError("Queue is full")
        now = time.time()
        db.execute(
            "INSERT INTO jobs(pr,sha,ref,created,updated) VALUES(?,?,?,?,?)",
            (0, sha, ref, now, now),
        )
    return "queued"


class Handler(BaseHTTPRequestHandler):
    server_version = "AquillaWebhook"

    def log_message(self, *_args):
        # Do not log artifact bearer URLs or webhook payloads.
        pass

    def reply(self, code, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/aquilla-qa/health":
            self.reply(200, {"service": "aquilla-qa", "status": "listening"})
            return
        match = re.fullmatch(r"/aquilla-qa/artifacts/([a-f0-9]{64})/suite.json", self.path)
        if match:
            artifact = Path("/var/lib/aquilla-qa-evidence") / match[1] / "suite.json"
            try:
                if time.time() - artifact.stat().st_mtime < 7 * 86400:
                    self.reply(200, artifact.read_bytes())
                    return
            except FileNotFoundError:
                pass
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/aquilla-qa/github":
            self.reply(404, {"error": "not found"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 1_048_576:
                self.reply(413, {"error": "invalid body size"})
                return
            self.connection.settimeout(10)
            body = self.rfile.read(size)
            if not valid_signature(body, self.headers.get("X-Hub-Signature-256"), self.server.secret):
                self.reply(401, {"error": "invalid signature"})
                return
            job = parse_event(self.headers.get("X-GitHub-Event"), json.loads(body))
            status = enqueue(*job) if job else "ignored"
            self.reply(202, {"status": status})
        except (ValueError, TypeError, AttributeError):
            self.reply(400, {"error": "invalid event"})
        except (OverflowError, sqlite3.Error):
            self.reply(503, {"error": "queue unavailable"})
        except (TimeoutError, ConnectionError):
            self.close_connection = True


if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True)
    database().close()
    config = json.loads(Path("/etc/aquilla-qa/webhook.json").read_text())
    server = ThreadingHTTPServer(("127.0.0.1", 9086), Handler)
    server.secret = config["secret"]
    server.serve_forever()
