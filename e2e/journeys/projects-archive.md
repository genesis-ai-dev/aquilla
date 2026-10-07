# Archive a project from its overview

Smoke twin: `e2e/specs/projects/project-trash.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.
- A project alice owns exists and the org has at least one other active project.

## Steps

1. Open the project's overview page (`/projects/<id>`) by clicking its row on the org **Projects** page.
2. Click the **More actions** button in the page header.
3. Click the **Archive** menu item.
4. In the dialog, tick **I understand this project will be hidden from the active list.** The **Archive** button stays disabled until the box is ticked.
5. Click **Archive**.

## Expected end state

- The app navigates to the org **Projects** page.
- The project's row is gone from the active table. The other project is still listed.
- Under the org's **Archived** page the project is listed with a **More actions for <title>** button.

## Counts as a failure

- **Archive** is missing from the menu for a project alice owns.
- The confirm button enables before the box is ticked.
- The row is still in the active table, or missing from **Archived**.

## Notes for the agent

The history control in the sidebar reads **Back to <title>** after archiving. That is not a table row; do not count it as the project still being listed.
