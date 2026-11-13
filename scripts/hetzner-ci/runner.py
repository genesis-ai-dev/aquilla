"""Trusted serial controller. Release-branch code executes only in disposable containers."""
import json
import os
import re
import secrets
import selectors
import tarfile
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from webhook import REPO, RELEASE_REF, STATE, database

CODE = Path("/opt/aquilla-qa")
JOBS = Path("/var/lib/aquilla-qa-jobs")
# How long a job interrupted mid-report may hold the queue while its report is
# retried. Past this, the queue matters more than the report: a runner that
# looks healthy while testing nothing is the worse failure.
REPORT_GRACE = 900
CONFIG = Path("/etc/aquilla-qa/runner.json")
NETWORK = "aquilla-qa"
SHA = re.compile(r"[a-f0-9]{40}")
COMMON = ["--init", "--cgroup-parent=aquillaqa.slice", "--cpus=1.5",
          "--pids-limit=512",
          "--cap-drop=ALL", "--security-opt=no-new-privileges",
          "--log-opt=max-size=5m", "--log-opt=max-file=1"]
# Per-container memory. The aquillaqa.slice MemoryMax is the real ceiling for
# every QA container together; raise both, never only this one.
MEMORY_MB, SWAP_MB = 2200, 400
# Browser-facing URLs baked into the test-mode build. The app container builds
# before its workers start (app_bootstrap.prebuild); the test container must
# see the same addresses.
BROWSER_ENV = dict(VITE_AUTH_BASE="http://127.0.0.1:9787",
                   VITE_FRONTIER_BASE="http://127.0.0.1:9787",
                   VITE_CHAT_BASE="http://127.0.0.1:9787/chat",
                   VITE_SYNC_WORKER_HOST="127.0.0.1:9788")


def memory(config):
    memory_mb = int(config.get("container_memory_mb", MEMORY_MB))
    swap_mb = int(config.get("container_swap_mb", SWAP_MB))
    if not 512 <= memory_mb <= 16384 or not 0 <= swap_mb <= memory_mb:
        raise ValueError("Unreasonable container memory limits")
    return [f"--memory={memory_mb}m", f"--memory-swap={memory_mb + swap_mb}m"]


class ReportPending(Exception):
    pass


def command(args, log=None, timeout=900, env=None, check=True, input=None, on_output=None):
    if log is None:
        return subprocess.run(args, input=input, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout,
                              env=env, check=check)
    # PR install scripts may emit arbitrary output. Drain it without allowing
    # their build logs to exhaust the host filesystem outside Docker's quota.
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          env=env) as process, selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline, remaining = time.monotonic() + timeout, 8 * 1024 * 1024
        while selector.get_map():
            if time.monotonic() > deadline:
                process.kill()
                raise subprocess.TimeoutExpired(args, timeout)
            for key, _ in selector.select(0.5):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                log.write(chunk[:remaining])
                log.flush()
                remaining = max(0, remaining - len(chunk))
                if on_output:
                    on_output(chunk)
        code = process.wait(timeout=max(1, deadline - time.monotonic()))
        if check and code:
            raise subprocess.CalledProcessError(code, args)
        return subprocess.CompletedProcess(args, code)


def read_suite(container):
    # Stream one bounded regular file; never extract container tar paths on host.
    args = ["docker", "cp", container + ":/work/smart-tests/results/server/suite.json", "-"]
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        try:
            with tarfile.open(fileobj=process.stdout, mode="r|*") as archive:
                member = archive.next()
                if not member or not member.isfile() or member.size > 5_000_000:
                    raise ValueError("Invalid evidence archive")
                return json.load(archive.extractfile(member))
        finally:
            process.kill()
            process.wait()


def github(config, path):
    request = urllib.request.Request("https://api.github.com/repos/" + REPO + path,
        headers={"Authorization": "Bearer " + config["github_token"],
                 "Accept": "application/vnd.github+json", "User-Agent": "Aquilla-QA"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def current(config, ref, sha):
    if not RELEASE_REF.fullmatch(ref or ""):
        return False
    commit = github(config, "/commits/" + ref)
    return commit.get("sha") == sha


def report(config, ref, sha, phase, suite=None, url=None, status=None, progress=None):
    # Credentials travel over stdin, never command arguments or job logs.
    payload = dict(ref=ref, sha=sha, phase=phase, suite=suite, runUrl=url, progress=progress,
                   jobStatus=status, token=config["github_token"], author=config["author"])
    command(["node", str(CODE / "report.mjs")], timeout=150,
            input=json.dumps(payload).encode())


JOURNEY_HEADER = re.compile(rb"^\[(\d+)/(\d+)\] \S+ \xe2\x80\xba (.+?)\s*$")
JOURNEY_ERROR = re.compile(rb"^ {4}Error\b")


class Progress:
    """Keeps the release commit comment current while a job runs.

    Steps come from the app container's progress file (reviewed bootstrap
    code), journeys from Playwright's line reporter in the test log. Both are
    untrusted bytes and are validated and bounded before they reach the
    reporter. Publishing is best effort: a failed PATCH never fails the job,
    and the final "finished" report is still delivered the strict way.
    """

    def __init__(self, config, ref, sha, started):
        self.config, self.ref, self.sha, self.started = config, ref, sha, started
        self.steps, self.journeys, self.total = [], [], None
        self.buffer, self.sent = b"", None

    def steps_from(self, raw):
        try:
            entries = json.loads(raw[:4096].decode("utf-8", "replace"))
        except ValueError:
            return False
        if not isinstance(entries, list):
            return False
        steps = []
        for entry in entries[:8]:
            if not isinstance(entry, dict):
                return False
            name, seconds, detail = entry.get("name"), entry.get("seconds"), entry.get("detail", "")
            if not isinstance(name, str) or not isinstance(seconds, (int, float)) or not isinstance(detail, str):
                return False
            steps.append({"name": name[:40], "seconds": round(float(seconds), 1), "detail": detail[:80]})
        if steps == self.steps:
            return False
        self.steps = steps
        return True

    def stack_ready(self):
        elapsed = time.monotonic() - self.started
        self.steps.append({"name": "stack", "seconds": round(elapsed - sum(s["seconds"] for s in self.steps), 1),
                           "detail": "workers and preview up"})
        self.publish()

    def feed(self, chunk):
        self.buffer += chunk
        *lines, self.buffer = self.buffer.split(b"\n")
        for line in lines:
            header = JOURNEY_HEADER.match(line)
            if header:
                self.total = int(header.group(2))
                for journey in self.journeys:
                    if journey["state"] == "running":
                        journey["state"] = "finished"
                if len(self.journeys) < 64:
                    self.journeys.append({"title": header.group(3).decode("utf-8", "replace")[:120],
                                          "state": "running"})
                self.publish()
            elif JOURNEY_ERROR.match(line) and self.journeys and self.journeys[-1]["state"] == "running":
                self.journeys[-1]["state"] = "failed"
                self.publish()

    def payload(self):
        return dict(stage="tests" if self.journeys else "setup",
                    elapsedS=round(time.monotonic() - self.started),
                    steps=self.steps, journeys=self.journeys, total=self.total)

    def publish(self):
        # Snapshot: steps/journeys are mutated in place after this is sent.
        payload = json.loads(json.dumps(self.payload()))
        if payload == self.sent:
            return
        try:
            report(self.config, self.ref, self.sha, "running", progress=payload)
            self.sent = payload
        except Exception as error:  # noqa: BLE001 - progress is advisory
            print("Progress report:", type(error).__name__, flush=True)


def download(config, sha, destination):
    # GitHub's first response redirects to an expiring, pre-signed archive URL.
    # Never forward the Authorization header to the redirect host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None
    request = urllib.request.Request(f"https://api.github.com/repos/{REPO}/tarball/{sha}",
        headers={"Authorization": "Bearer " + config["github_token"],
                 "User-Agent": "Aquilla-QA"})
    try:
        urllib.request.build_opener(NoRedirect).open(request, timeout=30)
        raise RuntimeError("Expected GitHub archive redirect")
    except urllib.error.HTTPError as error:
        if error.code != 302:
            raise
        url = error.headers["Location"]
    if not url.startswith("https://codeload.github.com/"):
        raise RuntimeError("Unexpected archive host")
    with urllib.request.urlopen(url, timeout=90) as response, destination.open("wb") as out:
        total = 0
        while chunk := response.read(1_048_576):
            total += len(chunk)
            if total > 150_000_000:
                raise RuntimeError("Source archive exceeds limit")
            out.write(chunk)



def model_environment(config):
    required = {"TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY", "TYPESAFE_URL",
                "TYPESAFE_MODEL", "TEXT_MODEL", "TEXT_MODEL_BASE_URL",
                "TEXT_MODEL_REASONING"}
    supplied = config.get("model_env", {})
    if any(not isinstance(supplied.get(key), str) or not supplied[key] for key in required):
        raise ValueError("Explicit provider settings are required; no upstream defaults")
    # This deployment is provisioned for OpenRouter. A missing/wrong base URL
    # must fail before any credential can reach another model provider.
    for key, path in (("TYPESAFE_URL", "/api/alpha/decisions"),
                      ("TEXT_MODEL_BASE_URL", "/api/v1")):
        url = urlsplit(supplied[key])
        if (url.scheme != "https" or url.netloc != "openrouter.ai"
                or url.path.rstrip("/") != path or url.query or url.fragment):
            raise ValueError("Unapproved model provider endpoint")
    return {key: supplied[key] for key in required}


def cleanup_containers(prefix):
    for suffix in ("tests", "app", "db"):
        command(["docker", "rm", "-f", prefix + suffix], check=False, timeout=30)


def execute(config, job):
    job_id, _pr, sha, ref = job
    if not SHA.fullmatch(sha or ""):
        raise ValueError("Invalid persisted job")
    # Queued pull-request jobs have no release ref. Do not run them.
    if not RELEASE_REF.fullmatch(ref or ""):
        return "superseded"
    if not current(config, ref, sha):
        return "superseded"
    provider_env = model_environment(config)
    harness_sha = config["harness_sha"]
    if not SHA.fullmatch(harness_sha):
        raise ValueError("Invalid trusted harness")
    harness = "aquilla-qa-harness:" + harness_sha
    prefix = f"aquilla-qa-{job_id}-"
    directory = JOBS / str(job_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = directory / "source.tar"
    suite, status, artifact_url = None, "failure", None
    started = time.monotonic()
    try:
        report(config, ref, sha, "running")
        download(config, sha, source)
        if not current(config, ref, sha):
            return "superseded"
        limits = memory(config)
        command(["docker", "run", "-d", "--name", prefix + "db", *COMMON, *limits,
                 "--network=" + NETWORK, "--user=postgres", "--read-only",
                 "--tmpfs=/var/lib/postgresql/data:rw,uid=999,gid=999,size=256m",
                 "--tmpfs=/var/run/postgresql:rw,uid=999,gid=999,size=16m",
                 "--tmpfs=/tmp:rw,size=16m", "-e", "POSTGRES_PASSWORD=aquilla",
                 "-e", "POSTGRES_USER=aquilla", "postgres:16-bookworm"], timeout=60)
        for _ in range(60):
            result = command(["docker", "exec", prefix + "db", "pg_isready", "-U", "aquilla"], check=False)
            if result.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Database readiness timeout")
        # Reuse installed dependencies without building/copying a multi-GB image
        # for every commit. All PR extraction and install hooks stay sandboxed.
        app_env = dict(BROWSER_ENV, E2E_SERVE_ONLY="1", HUSKY="0",
                       E2E_PG_ADMIN_URL="postgresql://aquilla:aquilla@localhost:5432/postgres",
                       QA_BUILD_NODE_OPTIONS=str(config.get("build_node_options", "")))
        command(["docker", "create", "--name", prefix + "app", *COMMON, *limits,
                 "--network=container:" + prefix + "db",
                 *(f"-e={key}={value}" for key, value in app_env.items()),
                 harness, "python3", "/tmp/app_bootstrap.py"], timeout=60)
        # The enclosing job directory is root-only; the archive must be readable
        # by the unprivileged container user after docker cp.
        source.chmod(0o644)
        command(["docker", "cp", str(source), prefix + "app:/tmp/source.tar"], timeout=120)
        command(["docker", "cp", str(CODE / "app_bootstrap.py"),
                 prefix + "app:/tmp/app_bootstrap.py"])
        source.unlink()
        command(["docker", "start", prefix + "app"], timeout=60)
        progress = Progress(config, ref, sha, started)
        for _ in range(480):
            if command(["docker", "exec", prefix + "app", "test", "-f",
                        "/tmp/aquilla-stack-ready.json"], check=False).returncode == 0:
                progress.stack_ready()
                break
            steps = command(["docker", "exec", prefix + "app", "cat",
                             "/tmp/aquilla-qa-progress.json"], check=False)
            if steps.returncode == 0 and progress.steps_from(steps.stdout):
                progress.publish()
            running = command(["docker", "inspect", "-f", "{{.State.Running}}", prefix + "app"])
            if running.stdout.strip() != b"true":
                raise RuntimeError("Application setup exited")
            time.sleep(1)
        else:
            raise RuntimeError("Application readiness timeout")
        if not current(config, ref, sha):
            return "superseded"
        # Fixed trusted test image, separate mount/PID namespace, no host mounts.
        # Only the network namespace is shared to preserve localhost safeguards.
        test_env = dict(provider_env)
        test_env.update(BROWSER_ENV, CI="1", SMART_TEST_APP_SHA=sha, SMART_TEST_HARNESS_SHA=harness_sha,
                        SMART_TEST_RUN_ID="server", E2E_BASE_URL="http://127.0.0.1:6173",
                        E2E_DATABASE_URL="postgresql://aquilla:aquilla@localhost:5432/aquilla_e2e")
        args = ["docker", "run", "--name", prefix + "tests", *COMMON, *limits,
                "--shm-size=256m", "--network=container:" + prefix + "db"]
        for key in test_env:
            args += ["-e", key]
        args += [harness, "pnpm", "exec", "playwright", "test", "--config", "smart-tests/config.ts"]
        with (directory / "tests.log").open("wb") as log:
            result = command(args, log, timeout=960, check=False, env={**os.environ, **test_env},
                             on_output=progress.feed)
        suite = read_suite(prefix + "tests")
        if suite.get("build") != sha or suite.get("harnessBuild") != harness_sha:
            raise RuntimeError("Evidence identity mismatch")
        suite["runner"] = {"host": "hetzner", "wallMs": round((time.monotonic() - started) * 1000),
                           "job": job_id, "parallelStacks": 1}
        status = "success" if result.returncode == 0 else "failure"
        artifact_id = secrets.token_hex(32)
        artifact = Path("/var/lib/aquilla-qa-evidence") / artifact_id
        artifact.mkdir(parents=True, mode=0o755)
        (artifact / "suite.json").write_text(json.dumps(suite, indent=2))
        (artifact / "suite.json").chmod(0o644)
        artifact_url = f"https://aquilla-qa.5-161-201-46.sslip.io/aquilla-qa/artifacts/{artifact_id}/suite.json"
        return "completed" if status == "success" else "failed"
    finally:
        # Logs remain root-only. The public endpoint exposes only allowlisted evidence.
        for suffix in ("app", "db"):
            with (directory / (suffix + ".log")).open("wb") as log:
                command(["docker", "logs", prefix + suffix], log, check=False, timeout=30)
        cleanup_containers(prefix)
        if source.exists():
            source.unlink()
        outbox = dict(suite=suite, url=artifact_url, status=status)
        (directory / "report.json").write_text(json.dumps(outbox))
        try:
            report(config, ref, sha, "finished", **outbox)
        except Exception as error:
            raise ReportPending() from error


def drain_interrupted(config, job):
    """Deliver an interrupted job's report, then release the queue.

    A job stays 'interrupted' only while its report is still worth retrying.
    Once the grace window closes it becomes terminal, so one undeliverable
    report cannot stop every later PR from being tested.
    """
    job_id, _pr, sha, ref, interrupted_at = job
    cleanup_containers(f"aquilla-qa-{job_id}-")
    try:
        outbox_path = JOBS / str(job_id) / "report.json"
        outbox = json.loads(outbox_path.read_text()) if outbox_path.exists() else {}
        report(config, ref, sha, "finished", **outbox)
        status = "completed" if outbox.get("status") == "success" else "failed"
    except Exception as error:
        print("Interrupted report:", type(error).__name__, flush=True)
        if time.time() - interrupted_at <= REPORT_GRACE:
            return None
        # Fail loud: no report reached the PR, and we are giving up on it.
        print(f"Job {job_id} abandoned undelivered after {REPORT_GRACE}s", flush=True)
        status = "report-failed"
    with database() as db:
        db.execute("UPDATE jobs SET status=?,updated=? WHERE id=?", (status, time.time(), job_id))
    return status


def main():
    os.umask(0o007)
    STATE.mkdir(parents=True, exist_ok=True)
    # Interrupted jobs get an inconclusive report; they do not silently retry to green.
    with database() as db:
        # Stamp the interruption so the grace window below starts now, not at
        # whatever time the job was last touched before the process died.
        db.execute("UPDATE jobs SET status='interrupted',updated=? WHERE status='running'", (time.time(),))
    while True:
        config = json.loads(CONFIG.read_text())
        with database() as db:
            interrupted = db.execute(
                "SELECT id,pr,sha,ref,updated FROM jobs WHERE status='interrupted' LIMIT 1").fetchone()
            job = db.execute(
                "SELECT id,pr,sha,ref FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
            if job and not interrupted:
                db.execute("UPDATE jobs SET status='running',updated=? WHERE id=?", (time.time(), job[0]))
        if interrupted:
            drain_interrupted(config, interrupted)
            time.sleep(5)
            continue
        if not job:
            time.sleep(2)
            continue
        try:
            status = execute(config, job)
        except ReportPending:
            status = "interrupted"
        except Exception as error:
            status = "failed"
            print(f"Job {job[0]} failed: {type(error).__name__}", flush=True)
        with database() as db:
            db.execute("UPDATE jobs SET status=?,updated=? WHERE id=?", (status, time.time(), job[0]))
        print(f"Job {job[0]} {status}", flush=True)
        for root in (JOBS, Path("/var/lib/aquilla-qa-evidence")):
            if root.exists():
                children = sorted((child for child in root.iterdir() if child.is_dir()),
                                  key=lambda child: child.stat().st_mtime, reverse=True)
                for index, child in enumerate(children):
                    if index >= 200 or time.time() - child.stat().st_mtime > 7 * 86400:
                        shutil.rmtree(child)


if __name__ == "__main__":
    main()
