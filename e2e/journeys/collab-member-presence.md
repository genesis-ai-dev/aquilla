# Member presence popover shows above workspace chrome

Smoke twin: `e2e/specs/collab/member-presence-popover.smoke.spec.ts`

## Preconditions

- Logged in as `alice` in one session and `bob` in a second session.
- A project alice owns, with `bob` added as a member.

## Steps

1. Alice creates a project from the org **Projects** page: click **New Project**, fill **Project title**, **Source Language**, **Target language(s)**, click **Create Project**.
2. Alice opens **Project settings**, then the **Members** page, then clicks **Add a member**.
3. Alice types `bob` into the **Aquilla username** field, ticks the `bob` suggestion checkbox, and clicks **Add**. Bob's row appears in the members table with role **Contributor**.
4. Alice opens the project's editor.
5. Bob logs in and opens the same project's editor.
6. Alice finds the presence trigger in the editor's main area, a button showing bob's initials and named **BO bob**, and clicks it.
7. Alice presses **Escape**.

## Expected end state

- After step 6 a `dialog` labelled **1 online** appears, containing a list item with a disabled button named **BO bob online**.
- The popover sits fully on screen, not clipped or covered by the sidebar, header, or the workspace's bottom status bar.
- After step 7 the dialog is gone.

## Counts as a failure

- The **BO bob** trigger never appears (bob's presence never reaches alice's session).
- Clicking the trigger shows no dialog, or the dialog has no entry for bob.
- The dialog is cut off by another element, or does not close on **Escape**.

## Notes for the agent

The dialog's accessible name carries the count (`"1 online"`, `"2 online"`, and so on). Match it loosely rather than hardcoding the number. The dialog and its list item do not show up in an `-i` (interactive-only) snapshot. A plain `snapshot -c -s "main"` is needed to see the `dialog "1 online"` node and confirm the popover is real, not just an expanded trigger.

Bob's presence reached alice's already-open session without a reload on the cold run. Under load (several agents on one stack) it can take longer than the usual second or two. Poll for the **BO bob** trigger for up to 30 s before deciding it is missing, and say in the report whether a reload was needed.

Two page-wide `wait --text` traps on this path. **Project settings** is already on the overview page as the link's own label, so wait for "Roles & invites" (unique to the settings sidebar) after clicking it. **Contributor** is already visible as the add-member dialog's default role, so after clicking **Add** wait for `bob@local.test`, which only appears once the row lands in the table.

The **Aquilla username** field's accessible name comes from its `placeholder` attribute, not visible text. `wait --text "Aquilla username"` never matches it. Wait on the input by CSS selector (`input[placeholder="Aquilla username"]`) and fill it by snapshot ref.

The `bob` suggestion is a checkbox that `find role checkbox --name` misses. Pull its ref from the snapshot and `check "@ref"`. Take the enabled **Add** button's ref from the snapshot too, since it is disabled for a moment after typing and before the suggestion is ticked.
