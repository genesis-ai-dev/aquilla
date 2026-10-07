# Import a markdown file, edit a cell, and keep the edit across a reload

Smoke twin: `e2e/specs/editor/import-and-edit.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.
- A fresh project (create one first; see `projects-create.md`).
- The fixture `e2e/fixtures/sample.md` is on disk.

## Steps

1. From the project overview click **Open project**. The editor opens with the sidebar's **Files** panel and an **Import** button.
2. Click **Import**, then the **Upload files** card, then choose `sample.md`. The file input is the one inside the import dialog, not the cell audio inputs.
3. The **Import preview** shows. Click **Confirm import**.
4. `sample.md` appears in the Files panel and opens as a tab. The editor shows seven cells.
5. Click the first row's target cell (the textbox named **row 1 — empty**). Wait until an editable field is mounted inside that cell, then type a unique sentence into it.
6. Click anywhere in the sidebar to leave the cell. Leaving commits the edit.
7. Reload the page.

## Expected end state

- After step 6 the first row's target shows your sentence.
- After step 7 the same file is open and the first row's target still shows your sentence.

## Counts as a failure

- **Confirm import** never appears, or the file does not show in the Files panel.
- The typed text is not in the cell after leaving it.
- The text is gone after the reload.

## Notes for the agent

Typing at "current focus" right after clicking the read view is lost: the click swaps the read view for an editor, and focus lands on the new element a beat later. Wait for the editable element, then type into it by ref.
