# Create, edit, and delete a custom rule

Smoke twin: `e2e/specs/rules/rules-crud.smoke.spec.ts`

## Preconditions

- Logged in as `alice`.
- A fresh project (create one first; see `projects-create.md`).

## Steps

1. From the project overview, open `/project/<id>/rules` directly. It lands on the **Living Memory** page's **Rules** region.
2. Click **Add Rule**. A dialog titled **Create translation rule** opens with fields including **Rule name** and **Pattern**.
3. Click **Cancel**. The dialog closes and **Add Rule** is usable again.
4. Click **Add Rule** again. Type a unique name into **Rule name** and `foo` into **Pattern**, then click **Create rule**.
5. The dialog closes and the new rule's name appears in the Rules list.
6. Click that rule's **Edit rule** button. An inline editor opens beneath the row, with **Rule name** pre-filled with the name you typed.
7. Click the inline editor's **Cancel** button. The inline editor closes.
8. Find the trash-can button on that rule's row and click it.

## Expected end state

- After step 5 the rule's name is visible in the Rules list.
- After step 7 the inline editor (the pre-filled **Rule name** field) is gone from the page.
- After step 8 the rule's name is no longer anywhere on the page. Deletion has no separate confirm step.

## Counts as a failure

- **Add Rule** does nothing, or **Cancel** leaves the dialog open.
- **Create rule** does not add the rule to the list, or the list never shows its name.
- **Edit rule** does not open an inline editor, or the editor's **Rule name** field is blank instead of pre-filled.
- The rule's name is still present on the page after clicking its trash-can button.

## Notes for the agent

Opening `/project/<id>/rules` redirects to `/project/<id>/memory/quality`, same as the built-in-rule violation journey. That is expected, not a failure.

**Edit rule** is a toggle: the button you click to open the inline editor is not also how you close it. Closing goes through the inline editor's own **Cancel** button, which only exists while the editor is open. Do not click **Edit rule** a second time expecting it to close.

Snapshot refs (`@eN`) grabbed for this row are unusually quick to go stale. Clicking one silently no-ops (the command reports success but nothing on the page changes) because the Rules list re-renders on almost every action in it (dialog close, toggle open/close, row add/remove). `find role button click --name "..."` is more reliable here since it re-queries the live DOM at click time instead of trusting an earlier snapshot's node. The trash-can button on a rule's row has no accessible name (it is an icon-only button), so `find role button --name` cannot reach it; the row itself is a plain `<li>` containing the rule's name as text plus that unlabeled button. A CSS/DOM approach that finds the `<li>` by its text and clicks the button inside it works, where a name-based find does not.

After the redirect to `/memory/quality`, network-idle can settle before the Rules region has actually rendered its rows. Wait for a stable landmark in the region (e.g. the **Add Rule** button) before you rely on anything else in it being there.

A pointer click on the **Edit rule** icon button, whether by ref, by CSS selector, or by `find role button`, reports success but never opens the editor on the replay. A DOM click (`eval 'document.querySelector("button[aria-label=\"Edit rule\"]").click()'`) opens it every time. The cold run got through this step, so the cause is unclear; it may be the tooltip wrapper taking the pointer event. Worth a look from the app side.
