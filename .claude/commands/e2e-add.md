---
description: Scaffold a new E2E spec from template
argument-hint: <area> <journey-slug> [--smoke]
---

You are scaffolding a new Playwright E2E spec for codex-web-app.

Arguments: $ARGUMENTS

Steps:

1. Parse `$ARGUMENTS` into `<area>` (one of: auth, projects, orgs, editor, rules, validation, ai, collab, comments, sharing, audio-video, settings, export) and `<journey-slug>` (kebab-case, e.g. `password-reset`).
2. If `--smoke` is present, the filename is `<journey-slug>.smoke.spec.ts`. Otherwise `<journey-slug>.spec.ts`.
3. The full path is `e2e/specs/<area>/<filename>`.
4. Confirm the directory exists: `ls e2e/specs/<area>/` — create it with `mkdir -p` if not.
5. Read `e2e/JOURNEYS.md` to confirm there's no existing spec for this journey. If there is, ask the user whether to extend it instead.
6. Decide whether the test needs multi-user. If so, import from `../../helpers/multi-user`; otherwise from `@playwright/test`.
7. Write the spec using this template:

```ts
import { test, expect } from "../../helpers/multi-user" // OR @playwright/test
// import { Dashboard } from "../../helpers/page-objects/Dashboard"
// import { Workspace } from "../../helpers/page-objects/Workspace"

test("<journey description in plain English>", async ({ alice /* or page */ }) => {
  // 1. arrange — call helpers / page objects to reach the starting state
  // 2. act    — perform the user action under test
  // 3. assert — verify visible UI state with expect(...).toBeVisible/toContainText/etc.
})
```

8. Add a row to `e2e/JOURNEYS.md` under the right Area section, with a one-line journey description and the filepath.
9. Run the new spec to confirm it actually fails (no fake green from missing UI elements): `npm run test:e2e -- --grep "<journey description>"`.
10. Hand control back to the user with the failing test output.

Do NOT implement the test body for them — leave the arrange/act/assert comments. The user will fill it in.
