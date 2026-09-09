# Alice imports a file; bob sees it without asking

Smoke twin: `e2e/specs/collab/file-propagation.smoke.spec.ts`

## Preconditions

- `alice` is logged in and is a maintainer of Dev Org (org id 9).
- `bob` is logged in in a separate session. Bob is not a member of the project yet.
- The fixture `e2e/fixtures/sample.md` is on disk.

## Steps

1. **Alice** creates a project from `/orgs/9/projects`: click **New Project**, fill **Project title**, **Source Language** (`en`), **Target language(s)** (`fr`), click **Create Project**.
2. **Alice** clicks **Project settings**, then **Members**, then **Add a member**. She types `bob` into the **Aquilla username** field, clicks the **bob** suggestion checkbox that appears, then clicks **Add**. The Members table now shows a row for bob with role **Contributor**.
3. **Alice** closes the Members dialog, clicks **Open project**, clicks **Import**, then the **Upload files** card, then uploads `sample.md`. The **Import preview** shows. She clicks **Confirm import**.
4. `sample.md` appears in Alice's sidebar Files list.
5. **Bob** opens the same project's editor URL (`/project/<id>/editor`) directly, without reloading afterward.

## Expected end state

- Bob's sidebar Files list shows `sample.md` on this first load, with no reload needed. The file is a project-server-side fact, not something that has to sync into his browser first.

## Counts as a failure

- **Add** in the member dialog does nothing, or bob never appears in the Members table.
- `sample.md` does not appear in Alice's own sidebar after **Confirm import**.
- Bob's sidebar does not show `sample.md`, even after a reload.

## Notes for the agent

The typeahead for adding a member renders a `checkbox` named after the username (e.g. `bob`) below the **Aquilla username** field. `find role checkbox --name "bob"` misses it even though the snapshot lists it plainly. Click it by ref (`@eN`).

The **Add** button in the member dialog stays `disabled` until a suggestion checkbox is picked, not just from typing the username.

The sidebar **Project settings** link and the settings-panel **Members** link are both `link` role elements that `find role link --name` misses even though the snapshot lists them. Click them by ref.

`wait --text` only matches visible rendered text, not an accessible name that comes from a placeholder or aria-label, such as the **Aquilla username** textbox. `find label "Aquilla username"` also fails to locate that field. Wait for an element (`wait "[role=tabpanel]"` or similar) and fill the field by ref instead.
