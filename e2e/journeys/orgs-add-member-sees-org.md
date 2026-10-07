# Create an org, add bob as a member, and bob sees it in his switcher

Smoke twin: `e2e/specs/orgs/members.smoke.spec.ts`

## Preconditions

- Logged in as `alice` in one session and `bob` in a second session.
- `alice` is on an org-level page (for example `/orgs/9/overview`), where the top bar shows the **Organization switcher** combobox. The editor page that dev-login lands on has no switcher.
- `bob` has his own session open at `/` before `alice` adds him, so the switcher check can be tried live first.

## Steps

1. `alice`: open the **Organization switcher** combobox and click **Create**.
2. `alice`: in the **Create organization** dialog, fill the **Organization name** textbox with a unique name such as `Journey org 190550` and click **Create organization**. The app lands on the new org's overview page; the org id is in the URL (`/orgs/<id>/overview`).
3. `alice`: open `/orgs/<id>/members` and click **Add a member**.
4. `alice`: in the **Add a member** dialog (tabs **Add members** and **Invite by email**), fill the **Aquilla username** textbox with `bob`. Open the **Role** combobox and pick **Contributor**. The options are **Viewer**, **Contributor**, **Project Lead**, and **Maintainer**; **Maintainer** is preselected. Click **Add**.
5. `alice`: the **Roster** table now has a row for bob.
6. `bob`: open the **Organization switcher** combobox in the top bar and read its option list.

## Expected end state

- After step 5, the Roster table has a cell **Project access for bob bob** and, in the same row, a role cell **Contributor**.
- After step 6, the switcher's listbox has an option whose name contains the new org's name and **Contributor**, for example `J1 Journey org 190550 Contributor`. Expect to reload bob's page first: with bob's session already open at `/` before the add, the switcher did not pick up the new org live, nor after a 2 second retry; it appeared after one reload.

## Counts as a failure

- **Add a member** is missing from the new org's Members page.
- **Add** does nothing, or no row for bob appears in the roster.
- The new org is missing from bob's switcher listbox after a reload. (A reload needed to see it is worth a note, not a failure.)

## Notes for the agent

Dev Org (org id 9) does not work for this story. **Add a member** renders only for org Owners (`src/components/org/OrgMembersTable.tsx`: `isOwner = (callerOrgRoleLevel ?? 0) >= ROLE.OWNER`; a test in `src/pages/MembersPage.test.tsx` pins this), and `alice` is a Maintainer there, so she only sees **Add to projects**, whose dialog says "org-wide membership is unchanged." Also, bob's switcher already lists **DO Dev Org Guest** from his project-level grants, so "Dev Org appears for bob" is true before anything happens. A fresh org that `alice` creates makes her Owner and gives bob nothing to start with, which is what the story needs.

The org switcher is a `combobox`. `find role combobox click --name "Organization switcher"` works; the accessible name is `Organization switcher: <current org>`, and adding the trailing colon to `--name` made it miss.

`find role link click --name "Members"` misses the org nav's **Members** link even though the snapshot lists it plainly. Open `/orgs/<id>/members` directly.

`find placeholder "Aquilla username" fill "bob"` fills the username textbox. A checkbox named **bob** briefly appears below the field as a suggestion; you do not need to tick it. The **Add** button enables once the field has text.

Three buttons contain "Add": **Add to projects**, **Add a member**, and the dialog's **Add**. Use `find role button click --name "Add" --exact` for the submit.

The **Role** combobox opens a listbox; pick the option by its snapshot ref. Its option names carry a description after the role, for example `Contributor Can edit project content. Maximum level grantable via share link.`

Org membership is not pushed live to bob's switcher. The replay opens bob's session first, tries the switcher live, retries once after 2 seconds, then reloads `/`; every pass so far came from the reload path. Cell edits arrive over a socket within a second or two; membership does not.

`/__dev/login?as=bob` can land on a "You no longer have access to this project" screen with a **Back to dashboard** button, because other journeys change project membership in parallel. Opening `/` afterwards lands on `/orgs/all`, which has the switcher.
