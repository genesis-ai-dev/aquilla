# Alice edits a cell; bob, a Reviewer, validates it

Smoke twin: `e2e/specs/collab/cross-user-validate.smoke.spec.ts`

## Preconditions

- Two sessions: `alice` and `bob`, each logged in separately.
- `alice` is a maintainer of Dev Org (org id 9), reachable at `/orgs/9/projects`.
- The fixture `e2e/fixtures/sample.md` is on disk.

## Steps

1. **Alice**: from the org **Projects** page click **New Project**. Fill **Project title**, **Source Language** (`en`), **Target language(s)** (`fr`). Click **Create Project**.
2. **Alice**: click **Project settings**, then **Members Roles & invites**. Click **Add a member**. Type `bob` into the **Aquilla username** field. A checkbox labelled `bob` appears below it. Click it; bob turns into a chip labelled **Remove bob**. Open the **Role** combobox (it starts on **Contributor**) and read its option labels from the snapshot. They are **Viewer**, **Commenter**, **Reviewer**, **Contributor**, **Project Lead**, **Maintainer**, each with a one-line description. Click the option whose visible text starts with **Reviewer**. Click **Add**. The Members table now lists a row for bob with role **Reviewer**.
3. **Alice**: close the Members dialog, click **Open project**. Click **Import**, then the **Upload files** card, then choose `sample.md`. The **Import preview** shows. Click **Confirm import**.
4. **Alice**: click the first cell's target (the textbox named **row 1 — empty**). Wait for an editable field to mount inside that cell, then type a unique sentence. Click **aside** to leave the cell; leaving commits the edit.
5. **Bob** (a separate session, opened only after alice's edit is committed): open the same project's editor at `/project/<id>/editor/file/<fileId>` directly. The file id is in alice's URL after step 3.
6. **Bob**: wait for alice's sentence to appear in the first cell's target column. Poll (re-snapshot scoped to that cell) rather than reloading. Reload only if polling does not turn it up.
7. **Bob**: on that same cell, find the validation control. It sits to the left of the target text, inside the cell row (not hidden behind a hover-only action rail). Read its accessible name from the snapshot before clicking. For a cell someone else already validated it reads **Validated by others — row 1. Click to add your validation.** Click it.

## Expected end state

- After step 4, alice's cell shows her sentence, and a green check icon appears to its left (the cell auto-validates for its own author on commit. The button's accessible name becomes **Validated — row 1. Click to remove your validation.** for alice).
- After step 6, bob's editor shows the same sentence in the same cell, with no reload.
- After step 7, the validation control's accessible name changes to **Validated — row 1. Click to remove your validation.** and `aria-pressed` on it is `true`. Clicking it (or hovering, since the control is a hover-triggered popover trigger) opens a panel titled **Validated by** listing **alice** and **bob (you)**. The file's status bar at the bottom of the editor shows **1 validated** in green, and the row's target column carries a small green check-mark badge next to the text.

## Counts as a failure

- The **Role** combobox has no **Reviewer** option, or picking it does not stick (the Members table shows bob as something other than **Reviewer**).
- Bob's editor never shows alice's sentence, even after a reload.
- No validation control is visible or reachable for bob on that cell.
- Clicking the control does not flip its accessible name to **Validated — row 1. Click to remove your validation.**, or `aria-pressed` stays `false`.
- The **Validated by** panel is missing bob's own name after he validates.

## Notes for the agent

Cell 0 of `sample.md` is the **# Heading** line, not the first paragraph. The importer gives every structural heading its own cell ahead of the paragraph cells, so "cell 0" and "row 1" both mean the Heading row, and the paragraph "This is a **sample** markdown file..." is row 2.

Editing a cell auto-validates it for the person who typed it. Alice's own commit already shows a green check and an accessible name of **Validated — row 1. Click to remove your validation.** for her session before bob does anything. Bob is not adding the first validation, he is adding a second one. His button starts in the **Validated by others** state, not **Not validated**.

The validation control's accessible name is dynamic, and it embeds the cell's reference (`row 1` here, since `sample.md` carries no book/chapter reference). Match the fixed parts of the string (`Validated`, `Validated by others`, `Click to add your validation`, `Click to remove your validation`) rather than hardcoding the whole label if a different fixture is ever used.

The control renders only once the cell has content. An empty target cell shows no validation control at all, so do not look for it before alice's edit lands.

The control is a Base UI popover trigger with `openOnHover`. Clicking it both fires the validation toggle and opens the **Validated by** popover (accessible-name `expanded` flips to `true`); this is normal, not a stray double action. The popover portals outside the cell row, so scope a snapshot to `body` or leave it unscoped to see its contents. A snapshot scoped to `[data-cell-id]` will not show it.

On this cold run bob's very first navigation to the file already showed alice's sentence. No poll iterations and no reload needed. Real time between alice's commit and bob's open was only a few seconds.
