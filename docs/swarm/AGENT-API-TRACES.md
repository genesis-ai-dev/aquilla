# AGENT-API swarm — open traces / TODOs

Agents: append TODOs you could not finish, with file:line and enough context for a
fresh agent to pick up. Orchestrator: drain into wave briefs or sub-issues.

## Open

### W2-A (MCP adapter) — follow-ups

- **MCP tool coverage lags REST.** `sync-worker/src/external/mcp-tools.ts` ships 11
  tools (discovery, reads, translations, changesets). The doc's §4 surface also lists
  `create_project`/`update_project`, artifacts (`create_artifact_upload`,
  `inspect_artifact`), ingestion (`preview_import`, `prepare_import`), verification
  (`run_checks`), jobs (`get_job`), and export (`prepare_export`, `get_export`). These
  are unimplemented at the command layer (no `PlanImport`/`LinkMedia` in `commands.ts`
  yet) — add MCP tools as those commands land. `get_capabilities.commandKinds` and the
  tools/list catalog must be kept in sync when they do.
- **`maxCommandsPerChangeset` is `null`** in `get_capabilities` because Wave-1
  `commands.ts::validateCommands` enforces no per-changeset cap. If/when a cap is added
  (§8 open Q3 rate-limit/job-size numbers), publish the real value from
  `mcp-handlers.ts::getCapabilities`.
- **No OAuth 2.1 / connector-directory transport.** Auth is `aqk_` PAT bearer only
  (D12 defers OAuth). The MCP endpoint is stateless with no session id; a streamable-HTTP
  SSE stream (GET) is intentionally 405 (tools-only, no server-initiated messages). Add
  OAuth + optional SSE when connector-directory listing is pursued.
- **`list_projects` omits group-grant access.** Per the W2-A brief it unions
  project_members / created_by / org_members only; `resolveProjectRoleShared` also honors
  `group_project_grants`. A user whose ONLY access path is a group grant will not see the
  project in `list_projects` (though `get_project` on it still resolves). Widen the union
  if group-only access needs discovery. See `mcp-handlers.ts::listProjects`.

## Resolved

(none yet)
