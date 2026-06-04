# Manual Walkthrough: Org-Level Access Control (FRO-144)

**Purpose**: Human-clickable step-by-step verification of org membership, teams, and access revocation.  
**Related spec**: `e2e/specs/orgs/org-access-lifecycle.spec.ts`  
**Spec reference**: `aquilla-specs/05-user-stories/access-control-permission-semantics.md`  
**Time estimate**: ~25 minutes with two browser windows open.

---

## Prerequisites

- [ ] Local stack running (`npm run dev:all` or equivalent)
- [ ] Two browser windows (or profiles) open — one for "Alice" (org owner), one for "Bob"
- [ ] A third window/profile for "Carol" if testing team paths
- [ ] Backend reset to a clean state (`POST http://127.0.0.1:8787/__test__/reset`)

---

## Part 1 — Org membership grants project visibility

### 1.1 Alice creates a project

- [ ] Sign in as Alice (owner)
- [ ] Navigate to Projects (`/projects`)
- [ ] Click "New Project", enter name "Manual Test Project", set source/target language, click "Create Project"
- [ ] **Expected**: "Manual Test Project" appears in the project list

### 1.2 Bob cannot see the project (not a member yet)

- [ ] Sign in as Bob in the second browser window
- [ ] Navigate to Projects (`/projects`)
- [ ] **Expected**: "Manual Test Project" is NOT visible. Bob sees an empty list or only his own projects.

### 1.3 Alice invites Bob to the org

Using the org admin UI (or API):

- [ ] As Alice, navigate to Org Settings → Members
- [ ] Add Bob (`bob@example.test`) as Contributor
- [ ] **Expected**: Bob appears in the member list with "Contributor" role

### 1.4 Bob sees the project after invite

- [ ] In Bob's browser window, reload the Projects page (`/projects`)
- [ ] **Expected**: "Manual Test Project" now appears in Bob's list
- [ ] **Expected**: Bob's role indicator shows "Contributor" or equivalent

---

## Part 2 — Create team (group), add project and user

### 2.1 Alice creates a team

- [ ] As Alice, navigate to Org Settings → Teams (or `/org/teams`)
- [ ] Click "New Team", enter name "Translators"
- [ ] **Expected**: "Translators" team appears in the team list

### 2.2 Alice adds Bob to the Translators team

- [ ] In the Translators team detail, click "Add Member"
- [ ] Search for Bob, add him
- [ ] **Expected**: Bob appears in the Translators team member list

### 2.3 Alice attaches a project to the Translators team

- [ ] In the Translators team detail, click "Add Project"
- [ ] Select "Manual Test Project", set role to "Project Lead"
- [ ] **Expected**: "Manual Test Project" appears in the team's project list with "Project Lead" role

### 2.4 Verify Bob's effective role upgraded via group path

- [ ] As Alice, navigate to Org Settings → Members → Bob → View Access
- [ ] **Expected**: For "Manual Test Project", effective role shows "project_lead" (500) with path "group"
  (max-wins: group 500 beats org-contributor 400)

---

## Part 3 — Access revocation (critical path)

### 3.1 Remove Bob from the Translators team

- [ ] As Alice, navigate to Translators team → Members → remove Bob
- [ ] **Expected**: Bob no longer in team member list
- [ ] Reload Bob's Projects page
- [ ] **Expected**: Bob still sees "Manual Test Project" (org-contributor path still active)
- [ ] **Expected**: Bob's role on the project reverts to "Contributor" (no longer "Project Lead")

### 3.2 Revoke Bob's org membership entirely

- [ ] As Alice, navigate to Org Settings → Members → Bob → Remove
- [ ] Confirm removal
- [ ] **Expected**: Bob no longer appears in the org member list

### 3.3 Verify Bob can no longer see the project

- [ ] In Bob's browser window, reload Projects page
- [ ] **Expected**: "Manual Test Project" is GONE from Bob's list
- [ ] **Expected**: Navigating directly to the project URL (`/projects/<id>`) shows a 403 or "Not found" screen
  — NOT the project content

### 3.4 Verify direct grant survives org removal (OPQ-2 edge case)

This is documented-intentional behavior — confirm it works as specified:

- [ ] As Alice, re-add Bob to the org as Contributor
- [ ] As Alice, also add Bob directly to "Manual Test Project" as Project Lead
- [ ] Remove Bob from the org again
- [ ] **Expected**: Bob still sees "Manual Test Project" (direct `project_members` row survives)
- [ ] **Expected**: Bob's role shows "Project Lead" (direct grant, not org path)

---

## Part 4 — Carol via group path (team-only visibility)

This section needs a third user (Carol).

### 4.1 Add Carol to org as viewer

- [ ] As Alice, invite Carol to the org with role "Viewer"
- [ ] **Expected**: Carol sees all org projects (org-viewer path gives broad visibility — OPQ-1 behavior)

### 4.2 Add Carol to Translators team

- [ ] As Alice, add Carol to the Translators team
- [ ] **Expected**: Carol's effective role on "Manual Test Project" is now "Project Lead" (group beats org-viewer)

### 4.3 Detach project from team

- [ ] As Alice, remove "Manual Test Project" from the Translators team
- [ ] **Expected**: Carol still sees the project (org-viewer path active)
- [ ] **Expected**: Carol's role reverts to "Viewer" (group path gone)

### 4.4 Remove Carol from org

- [ ] As Alice, remove Carol from the org
- [ ] **Expected**: Carol's group memberships are also gone (cascade — no "ghost" group membership)
- [ ] **Expected**: Carol can no longer see "Manual Test Project"

---

## Part 5 — Edge cases automation misses

### 5.1 Revoked user's active session (OPQ-3)

This requires an active browser session for the revoked user:

- [ ] Open Bob's browser, navigate to "Manual Test Project" — confirm it loads
- [ ] In Alice's browser, revoke Bob's access (remove from org)
- [ ] WITHOUT reloading, attempt an action in Bob's browser (e.g., click a file, open editor)
- [ ] **Expected**: Bob's next API request fails with 403 (per-request resolution, no grace window)
- [ ] **Note**: Bob's existing WS connection may stay alive briefly — this is documented behavior (OPQ-3, v1 no forced kick)

### 5.2 Role display consistency (visual)

- [ ] As Bob (contributor), open a project in the editor
- [ ] **Expected**: No "admin" or "manage" UI elements visible (add members, archive, etc.)
- [ ] **Expected**: Contributor-appropriate actions only (editing cells, comments)

### 5.3 Invite link role cap

- [ ] As Alice (project lead), generate a share-invite link for a project
- [ ] Open the invite link in a new incognito window (or as Carol)
- [ ] **Expected**: The granted role is at most Contributor (400) regardless of what the invite was created with
- [ ] **Expected**: Admin/manage actions not available to the invited user

### 5.4 Maintainer cannot add members above their own role

- [ ] As Alice, add Bob as Maintainer (600) on a project
- [ ] Sign in as Bob
- [ ] Bob tries to invite Carol as Owner (700)
- [ ] **Expected**: Request fails — Bob can only grant up to his own level

---

## Pass criteria

All checkboxes above checked. Key invariants:

1. Org membership = sees ALL org projects (org path fires)
2. Removing org member = immediately no access on next request (max-wins, no grace)
3. Removing org member cascades to group memberships (no ghost groups)
4. Direct `project_members` rows survive org removal (OPQ-2 documented intent)
5. Detaching group project = role reverts to org baseline (not zero)
6. Invite links capped at Contributor (400)
