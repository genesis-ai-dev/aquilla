# Walkthrough — create an organization & change its settings

Real point-and-click documentation video of the two flows, recorded against the
live app with the `e2e/recordings` Showcase harness (doc mode: programmatic
cursor, click ripples, zoom-into-click, captions/chapters).

## Files

| File | What it is |
| --- | --- |
| `org-setup-REAL-recording.mp4` | The recording — 1280×800 H.264, ~48s. Drop-in for docs/Slack/issues. |
| `org-setup-REAL-recording.webm` | Same take, VP8/9. |
| `org-setup-REAL-recording.storyboard.json` | Chapters + caption/VO script with timings (assembler contract). |

## The flow (recorded)

**Create an organization**
1. Click the organization switcher (sidebar top).
2. Choose **+ Create org**, type the name, click **Create**.
3. The new org becomes the active workspace (onboarding checklist).

**Change its settings**
4. Open **Settings**, click **Rename** in the Identity card.
5. Edit the name, click **Save** — it propagates to the sidebar + breadcrumb at once.

## How it was made / how to re-record

This is produced by the Showcase harness, not by hand. The spec and the
how-to skills live on the recording branch (`rec/org-setup-doc`, PR #125):

- Spec: `e2e/recordings/specs/org-create-settings-doc.showcase.ts`
- Skill: `.claude/skills/record-docs-video/` (and `record-promo-video` for trailers)

Re-record from that branch:

```sh
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev \
  npm run record -- -g "Create an organization"
npm run record:assemble -- --slug demo-org-admin__create-org-and-settings
```
