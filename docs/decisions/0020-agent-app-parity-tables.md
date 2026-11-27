# 0020 — What the app can do and an agent cannot is written down as data

*Decided and recorded 2026-11-27.*

## Context

A user asked an agent on the Aquilla connector to import `.docx` files and was
told Aquilla cannot. The parse route could
(`sync-worker/src/external/import-parse-formats.ts::BINARY_PARSE_FILE_TYPES`).
The `fileType` hint on `preview_import` and `prepare_import` was a hand-written
list that predated docx, and on an OAuth connection `get_capabilities` carried
no format list, so the stale hint was the only statement the agent could read.

That is one instance of a wider problem. The app grows by adding to three
vocabularies: file types the Import dialog parses, kinds the event log accepts,
and commands in the catalog. Nothing asked, at the moment one of them grew,
whether the Agent API and its MCP tools grew with it. The answer was found
months later by a user. Writing the same check revealed a second instance at
once: an OAuth connection could stage a translation brief through its declared
tool and could never confirm it.

## Decision

`sync-worker/src/external/agent-app-parity.ts` holds three tables keyed by the
app's own vocabulary. Each row is one of three answers: `covered` (and the
command or tool that does it), `gap` (the app can, an agent cannot yet), or
`excluded` (the server emits it itself, or a human must).

- `sync-worker/src/external/agent-app-parity.ts::IMPORT_FORMAT_PARITY` is a
  `Record<FileType, …>` and
  `sync-worker/src/external/agent-app-parity.ts::EVENT_PARITY` is a
  `Record<EventKind, …>`. A new file type or event kind is a type error in that
  file until it has a row, and the sync-worker type check is part of the Workers
  build.
- `sync-worker/src/external/agent-app-parity.ts::OAUTH_COMMAND_PARITY` lists
  every agent-reachable command against the fixed tool list an OAuth connection
  gets (`sync-worker/src/external/mcp-chatgpt-tools.ts::CHATGPT_TOOLS`). Command
  kinds are strings, so a test compares the key set with the catalog.
- `sync-worker/src/__tests__/agent-app-parity.test.ts` holds every row to the
  code it describes: a `covered` format is one the route parses, a `covered`
  kind names a reachable command, an `EmitEvents` row is on the allowlist, a
  `covered` command names a declared tool, and the OAuth confirm gate
  (`sync-worker/src/external/mcp-chatgpt-tools.ts::CHATGPT_COMMAND_KINDS`)
  admits exactly the kinds those tools stage.
- Format lists an agent reads are built from the tables, never typed
  (`sync-worker/src/external/import-parse-formats.ts::FILE_TYPE_OVERRIDE_HINT`).

A `gap` row is allowed. The rule is that it is written by a person in a diff a
reviewer sees, not that there are none.

## Consequences

- Adding a file type to `src/lib/parsers/types.ts` or an event kind to
  `sync-worker/src/events/types.ts` now needs one more line, in a file that asks
  the question.
- The `gap` rows are the agent-parity backlog, readable in one place.
- `gap` is "not yet"; `sync-worker/src/external/ui-only.ts::UI_ONLY_SURFACES`
  stays the list that promises "never".

## Not covered yet

- Features that are neither file imports nor event-sourced: the auth-worker
  `/api/v2/*` routes (living-memory writes, source linking, org administration,
  billing). They have no single vocabulary to key a table by.
- Reads. Nothing lists the app's read hooks against the read tools.
- Whether a `covered` kind is reachable with every payload the app sends. The
  tables say a door exists, not that it is as wide as the app's.
- The gaps are not published to agents. `get_capabilities` publishes import
  formats and `uiOnly` only.
