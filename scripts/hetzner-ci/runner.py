"""Trusted serial controller. PR code executes only in disposable containers."""
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

from webhook import REPO, REPO_ID, STATE, database

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
          "--memory=2200m", "--memory-swap=2600m", "--pids-limit=512",
          "--cap-drop=ALL", "--security-opt=no-new-privileges",
          "--log-opt=max-size=5m", "--log-opt=max-file=1"]


class ReportPending(Exception):
    pass


def command(args, log=None, timeout=900, env=None, check=True, input=None):
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


def current(config, pr, sha):
    pull = github(config, f"/pulls/{pr}")
    return (pull["state"] == "open" and not pull.get("draft")
            and pull["head"]["sha"] == sha
            and pull["head"].get("repo", {}).get("id") == REPO_ID)


def report(config, pr, sha, phase, suite=None, url=None, status=None):
    # Credentials travel over stdin, never command arguments or job logs.
    payload = dict(pr=pr, sha=sha, phase=phase, suite=suite, runUrl=url,
                   jobStatus=status, token=config["github_token"], author=config["author"])
    command(["node", str(CODE / "report.mjs")], timeout=150,
            input=json.dumps(payload).encode())


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
    job_id, pr, sha = job
    if type(pr) is not int or pr <= 0 or not SHA.fullmatch(sha):
        raise ValueError("Invalid persisted job")
    if not current(config, pr, sha):
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
        report(config, pr, sha, "running")
        download(config, sha, source)
        if not current(config, pr, sha):
            return "superseded"
        command(["docker", "run", "-d", "--name", prefix + "db", *COMMON,
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
        command(["docker", "create", "--name", prefix + "app", *COMMON,
                 "--network=container:" + prefix + "db",
                 "-e", "E2E_SERVE_ONLY=1", "-e", "HUSKY=0",
                 "-e", "E2E_PG_ADMIN_URL=postgresql://aquilla:aquilla@localhost:5432/postgres",
                 harness, "python3", "/tmp/app_bootstrap.py"], timeout=60)
        # The enclosing job directory is root-only; the archive must be readable
        # by the unprivileged container user after docker cp.
        source.chmod(0o644)
        command(["docker", "cp", str(source), prefix + "app:/tmp/source.tar"], timeout=120)
        command(["docker", "cp", str(CODE / "app_bootstrap.py"),
                 prefix + "app:/tmp/app_bootstrap.py"])
        source.unlink()
        command(["docker", "start", prefix + "app"], timeout=60)
        for _ in range(480):
            if command(["docker", "exec", prefix + "app", "test", "-f",
                        "/tmp/aquilla-stack-ready.json"], check=False).returncode == 0:
                break
            running = command(["docker", "inspect", "-f", "{{.State.Running}}", prefix + "app"])
            if running.stdout.strip() != b"true":
                raise RuntimeError("Application setup exited")
            time.sleep(1)
        else:
            raise RuntimeError("Application readiness timeout")
        if not current(config, pr, sha):
            return "superseded"
        # Fixed trusted test image, separate mount/PID namespace, no host mounts.
        # Only the network namespace is shared to preserve localhost safeguards.
        test_env = dict(provider_env)
        test_env.update(CI="1", SMART_TEST_APP_SHA=sha, SMART_TEST_HARNESS_SHA=harness_sha,
                        SMART_TEST_RUN_ID="server", E2E_BASE_URL="http://127.0.0.1:6173",
                        E2E_DATABASE_URL="postgresql://aquilla:aquilla@localhost:5432/aquilla_e2e",
                        VITE_AUTH_BASE="http://127.0.0.1:9787",
                        VITE_FRONTIER_BASE="http://127.0.0.1:9787",
                        VITE_CHAT_BASE="http://127.0.0.1:9787/chat",
                        VITE_SYNC_WORKER_HOST="127.0.0.1:9788")
        args = ["docker", "run", "--name", prefix + "tests", *COMMON,
                "--shm-size=256m", "--network=container:" + prefix + "db"]
        for key in test_env:
            args += ["-e", key]
        args += [harness, "pnpm", "exec", "playwright", "test", "--config", "smart-tests/config.ts"]
        with (directory / "tests.log").open("wb") as log:
            result = command(args, log, timeout=960, check=False, env={**os.environ, **test_env})
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
            report(config, pr, sha, "finished", **outbox)
        except Exception as error:
            raise ReportPending() from error


def drain_interrupted(config, job):
    """Deliver an interrupted job's report, then release the queue.

    A job stays 'interrupted' only while its report is still worth retrying.
    Once the grace window closes it becomes terminal, so one undeliverable
    report cannot stop every later PR from being tested.
    """
    job_id, pr, sha, interrupted_at = job
    cleanup_containers(f"aquilla-qa-{job_id}-")
    try:
        outbox_path = JOBS / str(job_id) / "report.json"
        outbox = json.loads(outbox_path.read_text()) if outbox_path.exists() else {}
        report(config, pr, sha, "finished", **outbox)
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
                "SELECT id,pr,sha,updated FROM jobs WHERE status='interrupted' LIMIT 1").fetchone()
            job = db.execute("SELECT id,pr,sha FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
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
