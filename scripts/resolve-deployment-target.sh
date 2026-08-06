#!/usr/bin/env bash
# Resolve GitHub event/ref metadata to one explicit Aquilla deployment target.
# Unknown live refs fail closed instead of falling through to development.
set -euo pipefail

event_name="${GITHUB_EVENT_NAME:-${1:-}}"
ref_name="${GITHUB_REF_NAME:-${2:-}}"

if [ -z "$event_name" ] || [ -z "$ref_name" ]; then
  echo "ABORT: GITHUB_EVENT_NAME and GITHUB_REF_NAME are required." >&2
  exit 1
fi

if [ "$event_name" = "pull_request" ]; then
  mode="preview"
  wrangler_environment="preview"
  live_environment="development"
  github_environment="non-production"
  api_host="api.dev.aquilla.app"
else
  mode="live"
  case "$ref_name" in
    main)
      wrangler_environment="production"
      live_environment="production"
      github_environment="production"
      api_host="api.aquilla.app"
      ;;
    dev)
      wrangler_environment="development"
      live_environment="development"
      github_environment="non-production"
      api_host="api.dev.aquilla.app"
      ;;
    *)
      echo "ABORT: '$ref_name' is not an authorized live deployment branch." >&2
      exit 1
      ;;
  esac
fi

emit() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$1" "$2"
  fi
}

emit mode "$mode"
emit wrangler_environment "$wrangler_environment"
emit live_environment "$live_environment"
emit github_environment "$github_environment"
emit api_host "$api_host"
emit sync_worker_host "$api_host/sync"
emit auth_base "https://$api_host/identity"
emit chat_base "https://$api_host/chat"
