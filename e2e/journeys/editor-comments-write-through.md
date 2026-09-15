# Post a comment on a cell and see it write through

Smoke twin: `e2e/specs/editor/comments.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.
- A fresh project (create one first; see `projects-create.md`).
- The fixture `e2e/fixtures/sample.md` is on disk.

## Steps

1. From the project overview click **Open project**, then import `sample.md` (see `editor-import-and-edit.md` steps 2-3). The editor shows seven cells.
2. Hover the first row so its action rail appears, then click **Add comment**.
3. A comments panel opens on the right with the heading **Comments** and a box labelled **Start a new comment thread...**.
4. Type a unique sentence into that box. The **Post** button goes from disabled to enabled once there is text.
5. Click **Post**.

## Expected end state

- The comment text appears in the comments panel, attributed to `alice`.
- The first row now carries an open-comment badge (button named **1 open comment — open comments**), visible without hovering.
- The sidebar's **Comments** nav button now reads **Comments 1**.

## Counts as a failure

- **Add comment** never appears on the row.
- The comments panel does not open, or **Post** stays disabled after typing.
- The typed comment is not in the panel after posting.
- The row's open-comment badge or the sidebar's comment count does not update.

## Notes for the agent

The row's action rail (the strip of buttons including **Add comment**) only renders while `data-revealed="true"` on `[data-slot="cell-action-rail"]`, and that flag has its own idle timeout separate from the mouse staying put: it collapses about 2.2 seconds after the last "fresh" hover gesture even if the pointer never left the row (see `useRailIdleHide`). A CSS-selector `hover` on the row is not reliable at raising it. It worked once and then silently no-opped on later attempts in the same session with no error. What works every time: move the mouse to a point outside the row, then to a point inside it (two separate `mouse move x y` calls), then immediately `find role button click --name "Add comment"` (not a ref grabbed from a prior snapshot. By the time a snapshot round-trip and a second ref-based click both complete, the rail can have already re-collapsed and remounted, so the old ref points at a detached node and the click fails with "Could not locate element").

Once posted, do not re-check the panel by re-hovering the row: the open-comment badge and the sidebar's "Comments N" count are both always-visible, so they are the steadier things to assert against.

The comment textbox in the drawer (**Start a new comment thread...**) carries its label only as a placeholder, not rendered text, so `wait --text` never matches it even though the drawer is open. Wait for the drawer container itself instead. The same gap applies to reading the posted comment back: it is plain text, not an interactive element, so an `-i` (interactive-only) snapshot never shows it even though it is on the page. Use `get text` on the drawer to read it.
