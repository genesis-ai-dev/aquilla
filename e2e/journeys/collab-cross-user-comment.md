# Alice posts a comment; bob sees it on the comments page

Smoke twin: `e2e/specs/collab/cross-user-comment.smoke.spec.ts`

## Preconditions

- `alice` is logged in and is a maintainer of Dev Org (org id 9).
- `bob` is logged in in a separate session.
- The fixture `e2e/fixtures/sample.md` is on disk.

## Steps

1. **Alice** creates a project from `/orgs/9/projects`: click **New Project**, fill **Project title**, **Source Language** (`en`), **Target language(s)** (`fr`), click **Create Project**.
2. **Alice** clicks **Project settings**, then **Members** (the tab reads **Members Roles & invites**), then **Add a member**. She types `bob` into the **Aquilla username** field and clicks **Add**. A `bob` suggestion checkbox appears while typing; leave it alone (see notes). The Members table shows a row for bob with role **Contributor**. Navigating away closes the dialog.
3. **Alice** clicks **Open project**, clicks **Import**, then the **Upload files** card, then uploads `sample.md`. The **Import preview** shows. She clicks **Confirm import**. The editor shows seven cells.
4. **Alice** clicks the first row's **Open cell details** button. The row expands and its action buttons stay visible. She clicks that row's **Add comment** button. A comments drawer opens on the right, with a **Start a new comment thread...** textbox and a **Post** button.
5. **Alice** types a unique sentence into that textbox and clicks **Post**. The sentence appears in the drawer as a new comment thread.
6. **Bob** opens `/project/<id>/comments` for the same project id from alice's URL.
7. **Bob** checks the page for alice's sentence. If it is not there yet, he clicks **Refresh** and checks again, repeating a few times.

## Expected end state

- After step 5 alice's drawer shows her sentence under a new comment thread.
- After step 6 or 7 bob's comments page shows the same sentence, attributed to alice.

## Counts as a failure

- **Add** stays disabled after typing `bob`, or bob is missing from the Members table after clicking it.
- **Add comment** never appears on the row, or clicking it does not open a comments drawer.
- **Post** does nothing, or alice's sentence is not in her own drawer after posting.
- Bob's comments page never shows alice's sentence, even after several clicks of **Refresh** over 15 seconds.

## Notes for the agent

The row's action rail (where **Add comment** lives) only renders on a fresh hover and disappears again after a couple of seconds, even if the pointer stays still. Move the mouse off the row first, then onto the row's own coordinates, then read the snapshot and click **Add comment** right away. Do not let other commands run between the hover and the click. This worked when driven interactively step by step on the cold run, but failed twice in the scripted replay: each `agent-browser` invocation is a separate process, and the gap between the "mouse move" command and the following "snapshot" command was enough by itself to miss the ~2-second window before the rail hides. The replay instead clicks that row's **Open cell details** button, which pins the whole action set (including **Add comment**, or **N open comment(s)** if a thread already exists) in the DOM with no hover needed, and that was reliable.

Typing `bob` into **Aquilla username** is enough on its own to enable **Add**. The `bob` suggestion checkbox is not required. Clicking the checkbox and then **Add** right after is a race: the checkbox's re-render can land after **Add** already fired, or land before **Add** has actually enabled, and on this stack that intermittently sends no request at all, leaving bob out of the Members table. The replay clicks **Add** directly off the typed username and skips the checkbox.

The comments drawer has no accessible heading text worth waiting on for the textbox: `wait --text "Start a new comment thread"` times out because that string is placeholder text inside an empty input, not rendered text. Wait for the drawer's container instead (`[data-testid="comments-drawer"]`, matching the smoke spec), or just proceed once the click on **Add comment** returns.

The posted comment's own text is real rendered text, so waiting on it directly works once it is posted (`wait --text "<your sentence>"`). Oddly, a `snapshot -c` scoped to the drawer does not expose that text as a node at all (it is not treated as an accessible name anywhere in the tree); use `get text "[data-testid='comments-drawer']"` or plain `wait --text` instead of grepping a snapshot for it.

Bob's comments page fetches once on load, with no live subscription. Alice's comment write drains through a five-second outbox interval on the server side, so there is a real race if bob's page loads within a few seconds of alice's post. On this cold run alice's other setup steps (create project, add member, import, open the comment drawer) took long enough that by the time bob navigated to the comments page, the comment had already synced. It showed up on first load, no **Refresh** click needed. A run where bob navigates faster should expect to need one or more **Refresh** clicks. A full page reload was never needed either way; **Refresh** is a button on the page, not a reload.
