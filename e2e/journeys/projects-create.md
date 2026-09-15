# Create a project and see it on the Projects list

Smoke twin: `e2e/specs/projects/create.smoke.spec.ts`

## Preconditions

- Logged in as `alice` (local stack: open `/__dev/login?as=alice`).
- Alice is a member of an org that already has at least one project.

## Steps

1. Open the org's **Projects** page.
2. Click **New Project**.
3. In the **Create New Project** dialog, type a unique title, `en` in **Source Language**, and `fr` in **Target language(s)**. The language fields are comboboxes that accept a typed code; no option list needs to open.
4. Click **Create Project**.
5. You land on the new project's overview page. Its title is the page heading and an **Open project** button is visible.
6. Go back to **Projects**.

## Expected end state

- The Projects table has a row with the new title.
- The URL after step 4 is `/projects/<id>`.

## Counts as a failure

- The dialog does not open, or **Create Project** does nothing.
- The overview heading is not the title you typed.
- The title is missing from the Projects table after step 6.

## Cleanup

Archive the project (see `projects-archive.md`), or leave it; local stacks are disposable.
