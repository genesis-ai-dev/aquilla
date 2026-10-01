# Aquilla plugin for ChatGPT and Codex

Connects ChatGPT (and Codex, through the shared plugin directory) to Aquilla's
MCP server, plus three project-management skills:

- `translation-status-report` — a plain-language report for a manager or funder
- `attention-queue` — what needs attention in one project this week
- `terminology-drift` — find inconsistent key terms and stage fixes for approval

Sign-in is OAuth: the user approves one project or organization, in ask or act
mode, on Aquilla's consent page. Every change is staged; in ask mode a person
approves it in Aquilla before it is saved.

How it works, how to test it in ChatGPT Developer Mode, and what is left:
[`docs/CHATGPT-PLUGIN.md`](../../docs/CHATGPT-PLUGIN.md).
`scripts/chatgpt-plugin.test.ts` checks this folder against the MCP server.
