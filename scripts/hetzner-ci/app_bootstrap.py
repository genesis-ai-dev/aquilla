"""Runs inside the credential-free app container, never on the host."""
import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

CACHES = {"node_modules", ".venv", ".pnpm-store", ".git"}
INPUTS = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
          ".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs"}


def dependency_identity(root):
    """Conservative cache: exact manifests/locks, no patches/custom install hooks."""
    digest = hashlib.sha256()
    reusable = True
    for directory, children, files in os.walk(root):
        children[:] = sorted(name for name in children if name not in CACHES)
        for name in sorted(files):
            path = Path(directory) / name
            if name not in INPUTS:
                continue
            relative = path.relative_to(root).as_posix()
            data = path.read_bytes()
            digest.update(relative.encode() + b"\0" + data + b"\0")
            if name in {".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs"}:
                reusable = False
            if name == "package.json":
                package = json.loads(data)
                if "patchedDependencies" in data.decode():
                    reusable = False
                for phase in ("preinstall", "install", "postinstall", "prepare"):
                    script = package.get("scripts", {}).get(phase)
                    # Git hooks do not run in this archive-only CI checkout.
                    if script and not (relative == "package.json" and phase == "prepare" and script == "husky"):
                        reusable = False
    return digest.hexdigest(), reusable


def clear_source(root):
    """Preserve installed dependency directories; remove all previous app source."""
    for child in root.iterdir():
        if child.name in CACHES:
            continue
        if child.is_dir() and not child.is_symlink():
            clear_source(child)
            if not any(child.iterdir()):
                child.rmdir()
        else:
            child.unlink()


def drop_node_modules(root):
    for directory, children, _files in os.walk(root):
        children[:] = [name for name in children if name not in {".venv", ".pnpm-store", ".git"}]
        if "node_modules" in children:
            shutil.rmtree(Path(directory) / "node_modules")
            children.remove("node_modules")


BROWSER_ENV = ("VITE_AUTH_BASE", "VITE_FRONTIER_BASE", "VITE_CHAT_BASE", "VITE_SYNC_WORKER_HOST")


def prebuild(root, bootstrap, env):
    """Build the app before the workers start, so the build never shares the
    container's memory cap with two wrangler dev servers (measured on the QA
    host: stack ~1.6 GB anon + build on top kills the container at 2.2 GB).
    Only when the reviewed e2e-up honours E2E_PREBUILT_DIST, else it would
    build twice. Returns True when e2e-up must skip its own build step."""
    if b"E2E_PREBUILT_DIST" not in bootstrap or not all(env.get(key) for key in BROWSER_ENV):
        return False
    build_env = {**env, "VITE_GOOGLE_CLIENT_ID": "", "VITE_GOOGLE_API_KEY": "",
                 "NODE_OPTIONS": env.get("QA_BUILD_NODE_OPTIONS", "")}
    shutil.rmtree(root / "dist", ignore_errors=True)
    started = time.monotonic()
    subprocess.run(["pnpm", "exec", "vite", "build", "--mode", "test", "--outDir", "dist"],
                   cwd=root, env=build_env, check=True)
    print(f"QA prebuild: test-mode dist ready in {time.monotonic() - started:.1f}s", flush=True)
    return True


def main():
    root = Path("/work")
    started = time.monotonic()
    before = dependency_identity(root)
    bootstrap = (root / "scripts/e2e-up.ts").read_bytes()
    clear_source(root)
    subprocess.run(["tar", "-xf", "/tmp/source.tar", "--strip-components=1",
                    "--no-same-owner", "-C", str(root)], check=True)
    after = dependency_identity(root)
    # Use the reviewed stack bootstrap; PR app code runs in this container only.
    (root / "scripts/e2e-up.ts").write_bytes(bootstrap)
    cached = before == after and before[1] and all(
        (root / directory / "node_modules/.modules.yaml").is_file()
        for directory in (".", "auth-worker", "sync-worker"))
    if cached:
        print("QA dependencies: reuse exact reviewed manifests and lockfiles", flush=True)
    else:
        print("QA dependencies: changed inputs; install isolated dependencies", flush=True)
        drop_node_modules(root)
        env = {**os.environ, "HUSKY": "0"}
        for directory in (root, root / "auth-worker", root / "sync-worker"):
            subprocess.run(["pnpm", "install", "--frozen-lockfile", "--store-dir=/tmp/qa-pnpm-store"],
                           cwd=directory, env=env, check=True)
        shutil.rmtree("/tmp/qa-pnpm-store", ignore_errors=True)
    # docker cp owns this archive as root in sticky /tmp. Container removal
    # deletes it; the unprivileged app does not need permission to unlink it.
    print(f"QA source/dependencies ready in {time.monotonic() - started:.1f}s; cached={cached}", flush=True)
    if prebuild(root, bootstrap, os.environ):
        os.environ["E2E_PREBUILT_DIST"] = "1"
    os.chdir(root)
    os.execvp("pnpm", ["pnpm", "exec", "tsx", "scripts/e2e-up.ts"])


if __name__ == "__main__":
    main()
