# Enable a built-in rule and see a violation surfaced in the editor

Smoke twin: `e2e/specs/rules/violation.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.
- A fresh project (create one first; see `projects-create.md`).
- The fixture `e2e/fixtures/sample.md` is on disk.

## Steps

1. From the project overview, open `/project/<id>/rules` directly (typing the URL, or via **Open project** then the rules link if the sidebar has one). It lands on the **Living Memory** page. The built-in rules live in its **Rules** region.
2. Find the switch named **Extra whitespace enabled**. If it is off, click it to turn it on.
3. Go back to the editor and import `sample.md` (see `editor-import-and-edit.md` steps 2-3).
4. The first cell ("Heading") is structural and carries no line number. Click the second cell's target read view (the textbox named **row 2 — empty**) and wait for an editable field to mount inside it.
5. Type text with two consecutive spaces in it, for example `this  has  double  spaces in e2e.` Typing must land as real doubled spaces, not collapse to one.
6. Click anywhere in the sidebar to leave the cell and commit the edit.

## Expected end state

- The second cell's line-number pill (inside the element labelled **Line 1**) tints amber, marking a minor rule violation.
- The typed text with its double space is visible in the cell's target column.

## Counts as a failure

- The **Extra whitespace enabled** switch is not on the Living Memory Rules region, or clicking it does nothing.
- The line pill stays its default color after committing the double-spaced text.
- The double space collapses to a single space in the committed text.

## Notes for the agent

Opening `/project/<id>/rules` redirects to `/project/<id>/memory/quality`. The Rules region is on that page, not a separate "/rules" screen. Don't treat the redirect as a failure. The redirect's network-idle can settle before the Rules region has actually rendered its rows, so wait for a stable landmark in it (e.g. the **Add Rule** button) before reading any switch state. Otherwise the check intermittently finds nothing.

On a fresh project the built-in rules, including **Extra whitespace**, are already enabled by default. The switch may already read `checked=true`. The journey still holds: check the switch state first and only click it if it is off.

Typing a run of consecutive spaces with the normal `type`/`fill` commands can lose the doubling. The editor is a ProseMirror surface that normalizes plain keystroke-by-keystroke input. Use `agent-browser keyboard inserttext "..."` after focusing the cell's editable element; it dispatches one input event instead of individual keydowns, so the doubled spaces survive.

The line-number pill is not part of an interactive-only (`-i`) snapshot; read its class or text with `eval` (`row.querySelector('[aria-label="Line 1"] span').className`) rather than looking for it in a snapshot.
