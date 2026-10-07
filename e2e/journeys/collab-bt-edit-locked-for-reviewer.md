# A reviewer cannot edit or generate a back-translation

Smoke twin: `e2e/specs/collab/bt-edit-locked-for-reviewer.smoke.spec.ts`

## Preconditions

- A fresh project (create one first; see `projects-create.md`) with the fixture `e2e/fixtures/sample.md` imported.
- Alice is the project owner. Bob is added as a **Reviewer** on the project (not just the org).
- Cell 0 already has a translation, and alice has generated a back-translation for it.

## Steps

1. **Alice** opens the project, imports `sample.md`, and types a translation into the first row's target cell (the textbox named **row 1 — empty**). Click **aside** to commit it.
2. **Alice** clicks **Open cell details** on the first row. The cell details panel opens with a **Back-translation** tab already selected.
3. **Alice** clicks **Generate back-translation**. A back-translation appears in the panel, and the button relabels to **Regenerate the back-translation** with an **Edit the back-translation** button next to it.
4. **Alice** opens **Project settings**, clicks **Members**, then **Add a member**. She types `bob` into the **Aquilla username** field, clicks the **bob** suggestion checkbox to add him as a chip, opens the **Role** combobox, picks **Reviewer**, then clicks **Add**. The members table now lists bob with the role **Reviewer**.
5. **Bob** opens the same project and file directly (no reload of a prior tab). He sees alice's translation in row 1 already.
6. **Bob** clicks **Open cell details** on row 1. The **Back-translation** tab is selected and shows alice's back-translation.

## Expected end state

- The back-translation panel bob sees, in the tab labelled **Back-translation**, contains a disabled control labelled **Contributor+ required to edit back-translations**.
- No button labelled **Generate back-translation** (or **Regenerate the back-translation**) is present anywhere in bob's back-translation panel.
- Bob never had to reload the page to see alice's translation or her back-translation; a fresh navigation to the file already carried both.

## Counts as a failure

- Bob's back-translation panel shows an enabled **Edit the back-translation** control, or any **Generate**/**Regenerate back-translation** button.
- The disabled control's label is missing or reads something other than **Contributor+ required to edit back-translations**.
- Bob cannot see alice's back-translation at all (a real regression, not just a locked-edit check).

## Notes for the agent

The local dev stack has a working deterministic local LLM, so **Generate back-translation** actually produces text here (unlike the Playwright spec, which points a mock LLM server at a per-test override. That override is not available to an interactive agent against the already-running stack). The generated text reads "I'm running in deterministic local mode..." with a "Matches this translation" badge, not the Playwright mock's "Traducción de prueba" string. Don't expect that exact string; check for the presence of the back-translation text and the "Matches this translation" badge instead.

Adding bob to the **Add a member** dialog needs two clicks, not one: fill the username field, then click the suggestion **checkbox** with bob's name that appears below it to turn him into a chip. Filling the field alone leaves **Add** disabled.

The cell details panel opens with the **Back-translation** tab already selected. There is no separate click needed to switch to it, for either user, once a back-translation exists on the cell.

Clicking the **Upload files** card opens a second panel, also headed "Upload files", with two buttons: **Choose Files** and **Choose Folder**. The real file input behind them is hidden (a `wait` on its selector times out on visibility) but the `upload` command reaches it fine without clicking either button first. Even so, the upload occasionally lands before the app has finished wiring the input's change handler: the panel just sits on "Upload files" instead of advancing to "Import preview," and a wait for **Confirm import** times out. If that happens, run the same `upload` command a second time; it clears it. This is not the two-step Choose Files/Choose Folder flow it looks like: it is a plain timing race on one hidden input.
