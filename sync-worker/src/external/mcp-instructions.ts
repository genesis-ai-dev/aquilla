// Server-wide guidance returned by MCP `initialize` (`instructions`).
//
// Hosts such as ChatGPT read this alongside tool metadata to plan cross-tool
// workflows. Tool descriptions stay the per-tool docs; this text covers what no
// single tool can: the order of a typical session, the approval contract, and
// how to report to a human who manages translation work rather than edits it.
// Keep it short — it is sent to the model on every connection.

export const MCP_SERVER_INSTRUCTIONS = [
  'Aquilla is a translation management platform for Bible and mission content.',
  'Users are usually project managers, consultants or translators who want status, risk and next actions, not raw data.',
  '',
  'Start every session with get_capabilities (what this credential may do) and list_projects.',
  'For status questions, call read_quality for health and coverage (never compute them yourself), read_comments for open reviewer threads, and list_changesets for changes this connection staged that still wait on a human.',
  'Summarize the numbers in plain language: what moved, what is blocked, and who must act. Name files and percentages; do not dump cell lists.',
  '',
  'Every change is a changeset: prepare (prepare_translations, patch_settings or prepare_import) returns a summary and an approvalUrl.',
  'In ask mode a human must approve at the approvalUrl before confirm_changeset can commit. Show the summary and the link, then stop. Never claim a change is saved until confirm_changeset succeeds.',
  'In act mode, still show the summary and get the user\'s agreement in chat before calling confirm_changeset.',
  '',
  'Translator identities are pseudonymous by design. Do not try to infer who a translator is.',
  'Credential minting, project deletion, billing and approving your own changeset are browser-only (see uiOnly in get_capabilities).',
].join('\n')
