# The setup checklist remembers whether it was open, not just that it exists

Smoke twin: `e2e/specs/editor/setup-checklist-survives-refresh.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.
- A fresh project with no files imported yet (create one; see `projects-create.md`), opened in the editor.

## Steps

1. From the project overview click **Open project**. The editor sidebar shows a **Setup: 1/4** chip.
2. Click the chip. A drawer opens with the heading **Project setup** and four steps: **Import files**, **Set translation instructions**, **Invite collaborators**, **Configure voice & transcription**.
3. Reload the page.
4. The drawer should reopen on its own, still showing the **Project setup** heading.
5. Click **Skip for now**. The drawer closes and the chip's label changes from **Setup: 1/4** to plain **Setup** (no fraction).
6. Reload the page again.
7. The drawer should stay closed this time; only the **Setup** chip should be present.

## Expected end state

- After step 3's reload, the **Project setup** heading is visible again without clicking anything.
- After step 6's reload, the **Project setup** heading is not present and only the **Setup** chip shows.

## Counts as a failure

- After the first reload (step 3), the drawer does not reopen on its own.
- After the second reload (step 6), the drawer reopens even though it was skipped.
- The chip never appears, or clicking it never opens the drawer.

## Notes for the agent

- The chip's accessible name changes with state: **Setup: 1/4** before anything is skipped, plain **Setup** (no fraction) once skipped. Match on the visible text you actually see, not a fixed label.
- Right after the first reload the drawer can take a beat to mount (this follows a full page load, not just a client-side render). Wait on the **Project setup** heading itself rather than a fixed sleep.
- The restored drawer is a modal sheet that hides the background from the accessibility tree, so the **Setup** chip is not a reliable post-reload readiness probe; wait on the drawer heading or its absence, not the chip.
- The chip itself can mount a beat after `wait --load networkidle` fires, from a second async fetch for the project's setup state. A `find role button --name "Setup"` right after opening the project can report "Element not found" even though the chip appears half a second later; retry the find for a few seconds instead of treating one miss as a failure.
