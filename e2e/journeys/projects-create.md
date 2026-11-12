# Create a project and see it on the Projects list

Smoke twin: `e2e/specs/projects/create.smoke.spec.ts`

## Preconditions

- Logged in as `alice` (local stack: open `/__dev/login?as=alice`).
- Alice is a member of an org that already has at least one project.

## Steps

1. Open the org's **Projects** page.
2. Click **New project**. The dialog first asks where the project comes from (AQU-2105); click **Start from scratch**.
3. In the **Create new project** dialog, type a unique title, `en` in **Source language**, and `fr` in **Language lanes**. The language fields are comboboxes that accept a typed code; no option list needs to open.
4. Click **Create project**.
5. You land on the new project's overview page, `/projects/<id>`. Its title is the page heading.
6. Go back to **Projects** and type the title into **Search projects…**.

## Expected end state

- The Projects table has a row with the new title.
- The URL after step 4 is `/projects/<id>`.

## Counts as a failure

- The dialog does not open, or **Create project** does nothing.
- The overview heading is not the title you typed.
- The title is missing from the Projects table after step 6.

## Notes for the agent

- The Projects table lists ten projects at a time with a load-more and sorts by activity, so a new project is not on its first page. Type the name into **Search projects…** (the search asks the server) and look for the row then; rows are one clickable element whose accessible name starts with the project name.
- The overview has no **Open project** text any more; it is `/projects/<id>` headed by the project name.
- The words follow the interface's word list (AQU-2261): **Project name**, **Source language**, **Language lanes**, **Create project**; "Project title" and "Target language(s)" are retired.

## Cleanup

Archive the project (see `projects-archive.md`), or leave it; local stacks are disposable.
