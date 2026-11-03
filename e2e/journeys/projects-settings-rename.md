# Rename a project from its settings and save

Smoke twin: `e2e/specs/projects/project-settings.smoke.spec.ts` (rename and lane-language part only; this journey does not touch the Knowledge Base upload part of that spec).

## Preconditions

- Logged in as `alice`.
- Alice is a member of an org that already has at least one project, or create one first (see `projects-create.md`).

## Steps

1. Open the project's overview page.
2. Click the **Project settings** link in the header.
3. You land on `/project/<id>/settings`. Click the **General** link (its accessible name starts with "General", followed by its line: "Name, languages, content structure, Bible data").
4. On the General pane, fill **Project name** with a new name.
5. Click **Save changes**.
6. Reload the page.
7. In the **Languages** table on the same pane, the source language is one line with a **Change** button. Click it; the lane's **Language**, **Name** and **Code** fields open. Fill **Language** with `English (US)` and click **Save**.
8. Reload the page.

## Expected end state

- After step 5 the **Save changes** button disappears (nothing left to save), a toast reads **Saved: project name.** and **Project name** shows the value you typed.
- After step 6 (reload) **Project name** still shows the new name.
- After step 8 (reload) the source language line reads **English (US)**.

## Counts as a failure

- **Project settings** or **General** does nothing, or the General pane never shows a **Project name** field.
- **Save changes** stays visible after clicking it, or the field reverts to its old value without an error.
- After reload, **Project name** does not show the renamed value.
- The source language line has no **Change** button, or after reload it does not read **English (US)**.

## Notes for the agent

- **Project settings** and **General** are sidebar-style links (icon plus text). `find role link --name` can miss them the way it misses other sidebar links; pull the ref from the snapshot and click by ref.
- The source language is not a field on the General pane any more (AQU-1594, 2026-10-06, then AQU-2168): it lives on the source lane in the Languages table. The line carries `data-testid="source-language-line"`, its button `data-testid="source-language-change"`, and the open editor `data-testid="lane-edit-<lane id>"` with `lane-language-<lane id>` and `lane-save-<lane id>` inside. The old `#sl` input is gone.
- The save confirmation is a toast reading **Saved: project name.** It can be gone by the time you snapshot again; the disappearance of the **Save changes** button is the more durable signal that the save went through.
- The words follow the interface's word list (AQU-2261): the New project dialog's fields are **Project name**, **Source language** and **Language lanes**; "Project title" is retired.

## Cleanup

The renamed project is left in the org's Projects table; local stacks are disposable.
