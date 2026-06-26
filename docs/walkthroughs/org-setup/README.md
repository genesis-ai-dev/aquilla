# Walkthrough — create an organization & change its settings

Real point-and-click documentation video of the two flows, recorded against the
live app with the `e2e/recordings` Showcase harness (doc mode: programmatic
cursor, click ripples, zoom-into-click, captions/chapters).

## Where the video lives

Video binaries are **not committed to git** — they live in the `aquilla-docs`
R2 bucket (Frontier R&D Cloudflare account):

| Object (key in `aquilla-docs`) | Format |
| --- | --- |
| `walkthroughs/org-setup/org-setup-create-and-settings.mp4` | 1280×800 H.264, ~48s |
| `walkthroughs/org-setup/org-setup-create-and-settings.webm` | VP8/9 |

The bucket is currently private. Fetch a copy with:

```sh
CLOUDFLARE_ACCOUNT_ID=6a80496d1e59948a9cbaa3c643ba81d7 \
  npx wrangler r2 object get aquilla-docs/walkthroughs/org-setup/org-setup-create-and-settings.mp4 \
  --file=org-setup-create-and-settings.mp4
```

(Once a public `r2.dev` URL or custom domain is enabled for the bucket, link it
directly here.)

`org-setup-REAL-recording.storyboard.json` (chapters + caption/VO script with
timings) stays in git — it's tiny and useful on its own.

## The flow (recorded)

**Create an organization**
1. Click the organization switcher (sidebar top).
2. Choose **+ Create org**, type the name, click **Create**.
3. The new org becomes the active workspace (onboarding checklist).

**Change its settings**
4. Open **Settings**, click **Rename** in the Identity card.
5. Edit the name, click **Save** — it propagates to the sidebar + breadcrumb at once.

## How it was made / how to re-record

Produced by the Showcase harness, not by hand. The spec and the how-to skills
live on the recording branch (`rec/org-setup-doc`, PR #125):

- Spec: `e2e/recordings/specs/org-create-settings-doc.showcase.ts`
- Skills: `.claude/skills/record-docs-video/` and `record-promo-video`

Re-record from that branch, then re-upload to R2:

```sh
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev \
  npm run record -- -g "Create an organization"
npm run record:assemble -- --slug demo-org-admin__create-org-and-settings
CLOUDFLARE_ACCOUNT_ID=6a80496d1e59948a9cbaa3c643ba81d7 \
  npx wrangler r2 object put aquilla-docs/walkthroughs/org-setup/org-setup-create-and-settings.mp4 \
  --file=e2e/recordings/output/demo-org-admin__create-org-and-settings.mp4 \
  --content-type=video/mp4 --remote
```
