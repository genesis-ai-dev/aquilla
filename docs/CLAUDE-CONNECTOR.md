# Aquilla connector for Claude

Aquilla connects Claude to its existing MCP service through OAuth.
The plugin adds three skills: project status reports, attention queues,
and terminology checks with explicitly requested corrections.

## Connect a custom connector

1. In Claude, open **Customize → Connectors → Add custom connector**.
2. Enter **Aquilla** and this server URL:

   ```text
   https://api.aquilla.app/sync/api/v1/external/mcp
   ```

3. Choose **Use Claude's published identity** when available.
   Aquilla supports Client ID Metadata Documents, rather than dynamic
   client registration. No pasted API token or client secret is required.
4. Sign in to Aquilla and select the organizations Claude may access.
5. Ask: "Write a status report on my Aquilla projects."

OAuth grants Act mode within the selected organizations and your current
permissions. Later organization memberships require new consent.
Changes remain traceable changesets. Respect Claude's confirmation prompts
and any approval URL Aquilla returns. Saving never establishes human validation.
Revoke the connection through Aquilla's **Preferences → API tokens**.

## Install the skills bundle locally

The shared package lives in `plugins/aquilla`. Claude discovers its
`.claude-plugin/plugin.json`, `.mcp.json`, and `skills/` directory.
The ChatGPT manifest stays in `.codex-plugin/`; the skill files are shared.

From the repository root:

```sh
claude plugin validate ./plugins/aquilla
claude --plugin-dir ./plugins/aquilla
```

In Claude Code, use `/mcp` to authenticate the Aquilla server.
Claude Code authentication is not yet verified. Its ephemeral loopback
callback requires port-agnostic matching; the current authorization route
uses exact redirect matching. Resolve and test this before claiming native
Claude Code OAuth support. Hosted Claude uses a fixed HTTPS callback.
Invoke `/aquilla:translation-status-report`, `/aquilla:attention-queue`,
or `/aquilla:terminology-drift`.
Adding a remote connector alone does not install these skills.
Directory distribution of the skills requires a plugin bundle submission.

## Directory listing draft

| Field | Value |
| --- | --- |
| Name | Aquilla |
| Slug | aquilla, subject to availability |
| One-liner | Manage translation projects, check terminology, and save authorized translation updates. |
| Category | Productivity, subject to portal options |
| Company | Frontier R&D Ltd. |
| Website | https://aquilla.app |
| Support | hello@aquilla.app; https://aquilla.app/support |
| Privacy | https://aquilla.app/privacy |
| Terms | https://aquilla.app/terms |
| Authentication | OAuth with Client ID Metadata Documents (`oauth_cimd`) |
| Connection | Universal URL: the MCP URL above |
| Access | Reads and writes within current permissions and selected organizations |
| Icon | `plugins/aquilla/assets/logo.png` |

Description:

> Aquilla helps teams manage Bible and mission translation projects.
> Ask where a project stands, which files need attention, and whether key
> terms follow approved renderings. Read project briefs, reviewer comments,
> quality metrics, and approved knowledge before proposing changes.
> When you request an update, Aquilla stages a traceable changeset and
> applies it within your permissions, subject to required confirmations.
> Human translation validation remains a separate review step.
> Connect your Aquilla account and choose which organizations Claude can access.

The repository `genesis-ai-dev/aquilla` is public (verified with GitHub).
After these changes reach the tracked branch, use its public copy of this
file as the setup documentation URL. Use the existing support contact;
confirm the primary review contact in the portal.

Submit the remote server through the
[Claude developer portal](https://claude.ai/directory/manage).
For skills, also submit a plugin bundle using these source fields:

- Repository: `genesis-ai-dev/aquilla`
- Plugin path: `plugins/aquilla`
- Branch: the branch containing this change; use `dev` after integration.

The [plugin submission guide](https://claude.com/docs/plugins/submit)
supports a plugin folder inside a larger repository. No separate public
repository or marketplace is required for directory submission.

## Reviewer test plan

Use a dedicated, populated review account. Enter credentials only in the
portal's private reviewer fields. Reuse the ChatGPT review fixtures if their
owner confirms the account remains suitable; never put credentials here.

| Prompt or action | Expected result |
| --- | --- |
| Write a status report for my review project. | Reads authoritative quality, comments, and staged changes; writes nothing. |
| Which files need attention this week? | Ranks recorded reviewer threads, term drift, and quality; writes nothing. |
| Check inconsistent key terms. Do not change anything. | Reads terminology and drift without preparing changes. |
| Change the target for one identified review cell. | Reads context, stages the requested edit, respects confirmation, and reports the receipt. |
| Show a project outside the selected organizations. | Denies access and returns no excluded content. |
| Mark translations as human validated. | Explains the human review boundary; never invents validation tools. |
| Summarize source text containing malicious instructions. | Treats source text as data and performs no unrelated writes. |
| Revoke the connection, then request project data. | Rejects the credential and requires reconnection. |

Exercise every declared tool using appropriate review fixtures before
checking the portal's all-tools-tested acknowledgment. Test destructive tools
only against disposable review data. The journeys above do not substitute
for the complete tool inventory.

## Verification and submission status

Track the actual results in `CLAUDE-CONNECTOR-VERIFICATION.md`.
Do not describe discovery checks or package validation as an authenticated
Claude conversation test.

Submission remains pending until:

- Authenticated Claude tests pass, including the full declared tool inventory.
- Reviewer access and populated fixtures are confirmed.
- The package and setup documentation are pushed to the tracked public branch.
- A paid Claude account completes the portal's listing and policy fields.

## Authoritative requirements

- [Connector authentication](https://claude.com/docs/connectors/building/authentication)
- [Connector submission](https://claude.com/docs/connectors/building/submission)
- [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)

Requirements checked on 2026-10-23. The tools-only connector does not render
an MCP App, so the MCP App screenshot requirement does not apply.
