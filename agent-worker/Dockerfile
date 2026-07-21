# Sandbox container image for the Aquilla agent (AQU-AGENT contract §1).
#
# Base is Cloudflare's pre-built Sandbox container (must match the
# @cloudflare/sandbox SDK major.minor pinned in package.json — 0.7.x).
# We layer the data-wrangling Python packages the agent's Tier-2 code path
# relies on (pandas/openpyxl for spreadsheets, lxml/python-docx for docs,
# chardet for encoding sniffing, beautifulsoup4 for HTML/XML).
FROM docker.io/cloudflare/sandbox:0.7.0-python

# Use the SDK's Python variant explicitly. The generic image is not guaranteed
# to contain pip, which made the previous first deployment dependent on an
# unverified image detail.
RUN pip install --no-cache-dir \
    pandas \
    openpyxl \
    lxml \
    python-docx \
    chardet \
    beautifulsoup4
