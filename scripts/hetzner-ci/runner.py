"""Trusted serial controller. PR code executes only in disposable containers."""
import json
import os
import re
import secrets
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

from webhook import REPO, REPO_ID, STATE, database

CODE = Path("/opt/aquilla-qa")
CONFIG = Path("/etc/aquilla-qa/runner.json")
NETWORK = "aquilla-qa"
SHA = re.compile(r"[a-f0-9]{40}")
COMMON = ["--init", "--cgroup-parent=aquillaqa.slice", "--cpus=1.5",
          "--memory=2200m", "--memory-swap=2600m", "--pids-limit=512",
          "--cap-drop=ALL", "--security-opt=no-new-privileges",
          "--log-opt=max-size=5m", "--log-opt=max-file=1"]


def command(args, log=None, timeout=900, env=None, check=True, input=None):
    return subprocess.run(args, input=input, stdout=log or subprocess.PIPE,
                          stderr=log or subprocess.PIPE, timeout=timeout,
                          env=env, check=check)


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


def cleanup_containers(prefix):
    for suffix in ("tests", "app", "db"):
        command(["docker", "rm", "-f", prefix + suffix], check=False, timeout=30)


def execute(config, job):
    job_id, pr, sha = job
    if type(pr) is not int or pr <= 0 or not SHA.fullmatch(sha):
        raise ValueError("Invalid persisted job")
    if not current(config, pr, sha):
        return "superseded"
    harness_sha = config["harness_sha"]
    if not SHA.fullmatch(harness_sha):
        raise ValueError("Invalid trusted harness")
    harness = "aquilla-qa-harness:" + harness_sha
    prefix = f"aquilla-qa-{job_id}-"
    image = "aquilla-qa-app:" + sha
    directory = Path("/var/lib/aquilla-qa-jobs") / str(job_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = directory / "source.tar"
    suite, status, artifact_url = None, "failure", None
    started = time.monotonic()
    try:
        report(config, pr, sha, "running")
        download(config, sha, source)
        shutil.copyfile(CODE / "Dockerfile.app", directory / "Dockerfile")
        with (directory / "build.log").open("wb") as log:
            command(["docker", "build", "--network=" + NETWORK,
                     "--cgroup-parent=aquillaqa.slice", "--memory=2300m",
                     "--memory-swap=2600m", "--cpu-period=100000", "--cpu-quota=150000",
                     "--build-arg", "HARNESS_IMAGE=" + harness, "-t", image, str(directory)],
                    log, env={**os.environ, "DOCKER_BUILDKIT": "0"}, timeout=1200)
        source.unlink()
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
        command(["docker", "run", "-d", "--name", prefix + "app", *COMMON,
                 "--network=container:" + prefix + "db", image], timeout=60)
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
        test_env = {key: value for key, value in config["model_env"].items()
                    if key in {"TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY", "TYPESAFE_URL",
                               "TYPESAFE_MODEL", "TEXT_MODEL"}}
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
        command(["docker", "cp", prefix + "tests:/work/smart-tests/results/server/suite.json",
                 str(directory / "suite.json")])
        suite_path = directory / "suite.json"
        if suite_path.stat().st_size > 5_000_000:
            raise RuntimeError("Oversized evidence")
        suite = json.loads(suite_path.read_text())
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
        artifact_url = f"https://koinegreek.app/aquilla-qa/artifacts/{artifact_id}/suite.json"
        return "completed" if status == "success" else "failed"
    finally:
        # Logs remain root-only. The public endpoint exposes only allowlisted evidence.
        for suffix in ("app", "db"):
            with (directory / (suffix + ".log")).open("wb") as log:
                command(["docker", "logs", prefix + suffix], log, check=False, timeout=30)
        cleanup_containers(prefix)
        command(["docker", "image", "rm", image], check=False, timeout=60)
        command(["docker", "image", "prune", "-f"], check=False, timeout=60)
        if source.exists():
            source.unlink()
        report(config, pr, sha, "finished", suite, artifact_url, status)


def main():
    os.umask(0o007)
    STATE.mkdir(parents=True, exist_ok=True)
    # Interrupted jobs get an inconclusive report; they do not silently retry to green.
    with database() as db:
        db.execute("UPDATE jobs SET status='interrupted' WHERE status='running'")
    while True:
        config = json.loads(CONFIG.read_text())
        with database() as db:
            interrupted = db.execute("SELECT id,pr,sha FROM jobs WHERE status='interrupted' LIMIT 1").fetchone()
            job = db.execute("SELECT id,pr,sha FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
            if job and not interrupted:
                db.execute("UPDATE jobs SET status='running',updated=? WHERE id=?", (time.time(), job[0]))
        if interrupted:
            cleanup_containers(f"aquilla-qa-{interrupted[0]}-")
            try:
                report(config, interrupted[1], interrupted[2], "finished")
                with database() as db:
                    db.execute("UPDATE jobs SET status='failed',updated=? WHERE id=?", (time.time(), interrupted[0]))
            except Exception as error:
                print("Interrupted report:", type(error).__name__, flush=True)
            time.sleep(5)
            continue
        if not job:
            time.sleep(2)
            continue
        try:
            status = execute(config, job)
        except Exception as error:
            status = "failed"
            print(f"Job {job[0]} failed: {type(error).__name__}", flush=True)
        with database() as db:
            db.execute("UPDATE jobs SET status=?,updated=? WHERE id=?", (status, time.time(), job[0]))
        print(f"Job {job[0]} {status}", flush=True)
        for root in (Path("/var/lib/aquilla-qa-jobs"), Path("/var/lib/aquilla-qa-evidence")):
            if root.exists():
                for child in root.iterdir():
                    if child.is_dir() and time.time() - child.stat().st_mtime > 7 * 86400:
                        shutil.rmtree(child)


if __name__ == "__main__":
    main()
