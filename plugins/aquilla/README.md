# Aquilla plugin for Claude, ChatGPT and Codex

Connects Claude, ChatGPT and Codex to Aquilla's MCP server, plus three
project-management skills:

- `translation-status-report` — a plain-language report for a manager or funder
- `attention-queue` — what needs attention in one project this week
- `terminology-drift` — find inconsistent key terms and save authorized fixes

Sign-in is OAuth: you select one or more organizations on Aquilla's consent
page. OAuth connections use Act mode within that saved selection and your current
permissions. All current organizations selects today's organizations; later
memberships require a new grant. Changes use traceable changesets. Host
confirmation requirements still apply. Saving does not establish human
translation validation.

How it works, how to test it in ChatGPT Developer Mode, and what is left:
[`docs/CHATGPT-PLUGIN.md`](../../docs/CHATGPT-PLUGIN.md).
`scripts/chatgpt-plugin.test.ts` checks this folder against the MCP server.

Claude uses `.claude-plugin/plugin.json` with the same `.mcp.json`, assets,
and skill files. There is no separate server or copied skill set.
See [Claude setup and submission](../../docs/CLAUDE-CONNECTOR.md).

To connect Claude, open **Customize → Connectors → Add custom connector**.
Name it **Aquilla** and enter:

```text
https://api.aquilla.app/sync/api/v1/external/mcp
```

Use **Claude's published identity** for OAuth, sign in to Aquilla, and choose
the organizations you want to share. Ask for a project status report to start.
The remote connector provides tools; the plugin bundle also provides skills.

Privacy policy: [Aquilla privacy policy](https://aquilla.app/privacy).
Support: [Aquilla support](https://aquilla.app/support).
