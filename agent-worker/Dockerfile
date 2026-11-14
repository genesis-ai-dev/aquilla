# Sandbox container image for the Aquilla agent (AQU-AGENT contract §1).
#
# Since @cloudflare/sandbox 1.x the SDK ships no runnable base image: the
# `docker.io/cloudflare/sandbox:<version>` image is a donor (FROM scratch) that
# carries only `sandbox-shim`, the helper the SDK's `Files` class runs inside
# the container. The runtime image is ours. The donor's tag must be the exact
# @cloudflare/sandbox version pinned in package.json (the shim and the package
# speak a versioned protocol; test/runtime-policy.test.ts enforces the pairing).
# Bump both in the same PR (docs/DEPENDENCY-RULES.md). The shim arrives through
# a named stage rather than a bare `COPY --from=docker.io/...` so the pairing is
# one `FROM` line that tooling can read.
FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-shim

# Python is the runtime that matters here (the agent's Tier-2 pandas/openpyxl/
# lxml parsing path); Node serves Tier-1 JS snippets. The Python minor is a
# deliberate choice, not a tag to bump casually: every wheel pinned below is
# built per interpreter minor, so 3.13 -> 3.14 is a tested change.
FROM python:3.13-slim-trixie

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY --from=sandbox-shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# Versions pinned (Sep 18, 2026 infra pen-test): an unpinned `pip install`
# here meant every image rebuild silently picked up whatever each package's
# latest release was that day, with no re-review — the same supply-chain gap
# the Modal services (infra/modal/*.py) already close by pinning their
# third-party dependencies to exact commits/versions. pandas is held at the
# latest 2.x (2.3.3) rather than the current latest (3.0.6, released Jan
# 2026): pandas 3.0 has breaking API changes and there is no test coverage
# exercising the sandbox's pandas-based Tier-2 parsing path, so an unpinned
# `pip install` here had already been silently riding that major bump on
# every rebuild since Jan 2026 with nothing to catch a regression. Bumping
# any of these — pandas to 3.x included — should be a deliberate, tested
# change, not a side effect of rebuilding the image.
RUN pip3 install --no-cache-dir \
    pandas==2.3.3 \
    openpyxl==3.1.5 \
    lxml==6.1.3 \
    python-docx==1.2.0 \
    chardet==7.6.0 \
    beautifulsoup4==4.15.0 \
    pypdf==6.19.0 \
    odfpy==1.4.1 \
    ebooklib==0.20 \
    xlrd==2.0.2 \
    olefile==0.47

# The per-call runners the Durable Object execs (src/container-exec.ts names
# these paths and the interpreters; the build fails here if an interpreter is
# not where that module expects it).
COPY runner/run.py runner/run.mjs /opt/aquilla/
RUN /usr/local/bin/python3 --version \
    && /usr/bin/node --version \
    && /usr/bin/timeout --version >/dev/null \
    && test -x /usr/local/bin/sandbox-shim

# `exec()` starts in `/` whatever WORKDIR says; the Durable Object passes
# cwd=/workspace on every call. The container only needs to stay up: the
# Durable Object runs everything through `exec()`.
RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
