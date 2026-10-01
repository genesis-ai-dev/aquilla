# Aquilla plugin for ChatGPT and Codex

Connects ChatGPT (and Codex, through the shared plugin directory) to Aquilla's
MCP server, plus three project-management skills:

- `translation-status-report` — a plain-language report for a manager or funder
- `attention-queue` — what needs attention in one project this week
- `terminology-drift` — find inconsistent key terms and save authorized fixes

Sign-in is OAuth: you select one or more organizations on Aquilla's consent
page. ChatGPT uses Act mode within that saved selection and your current
permissions. All current organizations selects today's organizations; later
memberships require a new grant. Changes use traceable changesets. ChatGPT
confirmation requirements still apply. Saving does not establish human
translation validation.

How it works, how to test it in ChatGPT Developer Mode, and what is left:
[`docs/CHATGPT-PLUGIN.md`](../../docs/CHATGPT-PLUGIN.md).
`scripts/chatgpt-plugin.test.ts` checks this folder against the MCP server.
