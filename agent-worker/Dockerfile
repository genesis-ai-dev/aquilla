# Sandbox container image for the Aquilla agent (AQU-AGENT contract §1).
#
# Base is Cloudflare's pre-built Sandbox container (must match the
# @cloudflare/sandbox SDK major.minor pinned in package.json — 0.12.x).
# We layer the data-wrangling Python packages the agent's Tier-2 code path
# relies on (pandas/openpyxl for spreadsheets, lxml/python-docx for docs,
# chardet for encoding sniffing, beautifulsoup4 for HTML/XML, and bounded
# readers for common long-tail document containers).
FROM docker.io/cloudflare/sandbox:0.12.5-python

# Use the SDK's Python variant explicitly. The generic image is not guaranteed
# to contain pip, which made the previous first deployment dependent on an
# unverified image detail.
#
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
