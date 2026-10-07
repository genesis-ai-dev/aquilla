# Open the account switcher and reach Preferences

Smoke twin: `e2e/specs/orgs/account-switcher.smoke.spec.ts` (the "account switcher dropdown opens with session info" case only; the other three cases in that spec inject a second session's storage directly and are not a plain browser walkthrough).

## Preconditions

- Logged in as `alice`.

## Steps

1. From any page in the workspace, click the **Account menu: alice** button in the sidebar footer.
2. A menu opens listing the current account (**alice**, `alice@local.test`), **Preferences**, **Add another account**, and **Log out**.
3. Click **Preferences**. The URL becomes `/preferences` and a **Preferences** heading and dialog appear.
4. Click the **Workspace** link. The URL becomes `/preferences/workspace` and a **Workspace** heading appears.
5. Click **Close**.

## Expected end state

- After step 3, a **Preferences** dialog is visible with a level-1 heading **Preferences**.
- After step 4, the URL is `/preferences/workspace` and the heading reads **Workspace**.
- After step 5, the dialog is gone and the URL is back to the page you started from.

## Counts as a failure

- The **Account menu: alice** button does not open a menu, or the menu is missing **Preferences** or **Add another account**.
- Clicking **Preferences** does not navigate to `/preferences` or show the dialog.
- Clicking **Close** leaves the dialog open, or lands on a different page than the one you started from.

## Notes for the agent

- The button's accessible name includes the username: **Account menu: alice**. `find role button --name "Account menu: alice"` (with the colon) reports "Element not found" even though the snapshot lists it plainly; `find role button --name "Account menu"` (drop the colon and the rest) finds and clicks it. `find role menuitem --name` works fine once the menu is open.
- The **Workspace** link inside the Preferences dialog is missed by `find role link --name`, the same way sidebar links are. Pull its ref from the snapshot and click by ref.
- `wait --load networkidle` right after `open .../login?as=alice` can return before the redirect to the workspace finishes; call it again (or check `get url`) if the first check shows the login URL still active.
