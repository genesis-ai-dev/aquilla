# Walkthrough — read a project, step by step (project tour)

Real point-and-click documentation video recorded against the live app with the
`e2e/recordings` Showcase harness (doc mode: programmatic cursor, click ripples,
zoom-into-click, captions/chapters).

## Files

| File | What it is |
| --- | --- |
| `project-tour.mp4` | The recording — 1280×800 H.264, ~39s. Drop-in for docs/Slack/issues. |
| `project-tour.storyboard.json` | Chapters + caption/VO script with timings. |
| `project-tour.editlist.json` | Assembler edit-list (cuts/zooms). |

## Chapters (feature → timestamp)

| Time | Chapter | Feature (CSV ID) |
| --- | --- | --- |
| 00:01 | Open a project | `PO-05` Open project button |
| 00:11 | Source ↔ target, verse by verse | `EC-01` Cell text editing |
| 00:22 | Validation at a glance | `VH-12` Health ring visual indicator |
| 00:29 | That's the workspace | (summary) |

## How it was made / re-record

Produced by the Showcase harness from the `demo-curated-doc` spec on the
recording branch (`rec/org-setup-doc`), not by hand:

- Spec: `e2e/recordings/specs/demo-curated-doc.showcase.ts`

```sh
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev \
  npm run record -- -g "Documentation walkthrough"
npm run record:assemble -- --slug demo-curated__documentation-walkthrough
```
