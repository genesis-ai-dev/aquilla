# Rename a project from its settings and save

Smoke twin: `e2e/specs/projects/project-settings.smoke.spec.ts` (rename/save part only; this journey does not touch the Knowledge Base upload part of that spec).

## Preconditions

- Logged in as `alice`.
- Alice is a member of an org that already has at least one project, or create one first (see `projects-create.md`).

## Steps

1. Open the project's overview page.
2. Click the **Project settings** link in the header.
3. You land on `/project/<id>/settings`. Click the **General** link (its accessible name is "General <project title>").
4. On the General pane, fill **Project title** with a new name and fill **Source Language** with `English (US)`.
5. Click **Save changes**.
6. Reload the page.

## Expected end state

- After step 5 the **Save changes** button disappears (nothing left to save) and **Project title** and **Source Language** show the values you typed.
- After step 6 (reload) **Project title** still shows the new name.

## Counts as a failure

- **Project settings** or **General** does nothing, or the General pane never shows a **Project title** field.
- **Save changes** stays visible after clicking it, or the fields revert to their old values without an error.
- After reload, **Project title** does not show the renamed value.

## Notes for the agent

- **Project settings** and **General** are sidebar-style links (icon plus text). `find role link --name` can miss them the way it misses other sidebar links; pull the ref from the snapshot and click by ref.
- Right after reload, **Source Language** shows empty even though the rename landed on the server. This is not a bug in this journey: the real smoke spec (`project-settings.smoke.spec.ts`) only re-checks `#pname` (Project title) after reload, not the source language field, because that field's display needs a moment to rehydrate the language label from its code. Do not fail the story over an empty Source Language field right after reload; only check Project title there.
- The save confirmation is a toast reading **Saved: project title, source language**. It can be gone by the time you snapshot again; the disappearance of the **Save changes** button is the more durable signal that the save went through.

## Cleanup

The renamed project is left in the org's Projects table; local stacks are disposable.
