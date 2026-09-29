#!/usr/bin/env bash
# Asks CI to tag the build production is serving. `deploy:aquilla` calls this
# when tag-release.sh fails locally, so a live release is not left untagged.
# The workflow checks the live sites itself and tags nothing that fails.
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "WARN: gh is not installed, so CI cannot be asked to tag. Run the 'Tag Live Release' workflow from the Actions tab." >&2
  exit 1
fi

gh workflow run tag-live-release.yml --repo genesis-ai-dev/aquilla --ref dev
echo "Asked CI to tag the live release. Follow it at https://github.com/genesis-ai-dev/aquilla/actions/workflows/tag-live-release.yml"
