# Sandbox container image for the Aquilla agent (AQU-AGENT contract §1).
#
# Base is Cloudflare's pre-built Sandbox container (must match the
# @cloudflare/sandbox SDK major.minor pinned in package.json — 0.7.x).
# We layer the data-wrangling Python packages the agent's Tier-2 code path
# relies on (pandas/openpyxl for spreadsheets, lxml/python-docx for docs,
# chardet for encoding sniffing, beautifulsoup4 for HTML/XML).
FROM docker.io/cloudflare/sandbox:0.7.0

# SWARM-TODO(aqu-agent): could not build/verify this image — Docker is
# unavailable in this environment. Confirm `pip` resolves in the 0.7.0 image
# (it ships the python-variant sandbox with pip3); switch to `pip3` /
# `--break-system-packages` if the base is externally-managed. Verify at
# first deploy (out-of-band task; see ORCHESTRATION "OUT of v1").
RUN pip install --no-cache-dir \
    pandas \
    openpyxl \
    lxml \
    python-docx \
    chardet \
    beautifulsoup4
