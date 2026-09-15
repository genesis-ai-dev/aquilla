# Create an invite link, then join a project through it

Smoke twin: `e2e/specs/projects/share-invite.smoke.spec.ts` (the join/accept
test, "invite accept shows confirmation and the project surfaces on the
invitee's dashboard")

## Preconditions

- Logged in as `alice` in one session, `bob` in a second session.
- Alice is a maintainer of Dev Org (org id 9).

## Steps

1. **Alice**: from `/orgs/9/projects` click **New Project**. Fill **Project
   title** with a unique name, **Source Language** with `en`, **Target
   language(s)** with `fr`. Click **Create Project**.
2. **Alice**: on the project overview, click **Project settings**.
3. **Alice**: click **Members Roles & invites**.
4. **Alice**: click **Add a member**, then click the **Invite link** tab.
5. **Alice**: click **Create invite link**. A read-only textbox shows the
   invite URL (`http://.../join/<token>`) and a **Copy URL** button appears.
6. **Bob**: open the `/join/<token>` path from that URL.
7. **Bob**: the page shows **You're invited**, the project's name, and
   **Invited by alice — you'll join as Contributor**. Click **Accept
   invitation**.
8. **Bob**: navigate to `/orgs/all`. Find the project's row in the Projects
   table.

## Expected end state

- After step 5 the dialog shows a URL textbox whose value contains `/join/`.
- After step 7 bob's browser URL contains `/project/`.
- After step 8 the project's row on `/orgs/all` carries a **Shared** badge
  (`data-testid="project-shared-badge"`) next to its name.

## Counts as a failure

- **Create invite link** does not produce a URL textbox or a **Copy URL**
  button.
- The join page does not show the project name, or does not name alice as
  the inviter.
- **Accept invitation** does not move bob's URL to a `/project/...` path.
- The project never appears in bob's `/orgs/all` table, or appears without
  the **Shared** badge.

## Notes for the agent

Right after **Create Project**, the project overview keeps loading extra
content (Autopilot, Team) for a beat. A click on **Project settings** during
that reflow can land on nothing and the settings panel never opens. Wait for
the page to settle (for example wait for the text **Team** to appear, then
`wait --load networkidle`) before clicking **Project settings**, and be
ready to retry the click once or twice if the panel doesn't show.

After clicking **Add a member**, the dialog opens on the **Add members**
tab; click the **Invite link** tab (a `role="tab"`, not a link) to reach
**Create invite link**.

`find role link click --name "Project settings"` returns "Element not
found" although the snapshot lists `link "Project settings"`. The same goes
for `link "Members Roles & invites"` on the settings page. Pull the ref out
of the snapshot (`grep -o 'link "Project settings" \[ref=e[0-9]*'`) and
click by ref. `find role button` and `find role tab` worked every time.

`wait --text "Copy URL"` timed out once even though the button was already
present in the very next snapshot. The invite-link request itself is fast,
but the wait call raced it. Read the read-only URL textbox with
`get value "input[readonly]"` in a short retry loop instead of a page-wide
text wait.

The same trap hit `wait --text "Members Roles & invites"` on a later cold
run: it ran its full 30 s and reported a timeout while the very next
snapshot listed `link "Members Roles & invites"`. After each click on this
path, `wait --load networkidle` and then grep a fresh `snapshot -i -c` for
the label you expect.

The **Add a member** dialog has no `role="dialog"` node, so
`snapshot -s '[role="dialog"]'` finds nothing. Snapshot the whole page (the
dialog is small) or read the URL straight from the readonly input.

The project row's "Shared" badge sits next to a second **New** badge
(`data-testid="new-shared-badge"`) that marks it as recently shared, not a
permanent label. Check for the `project-shared-badge` testid specifically,
not just the word "Shared" anywhere on the row.
