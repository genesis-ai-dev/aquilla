# Aquila Migration — QA Checklist for Anna (Come and See)

**Purpose:** an outcome-based pass/fail sheet for Anna to run a short (a few hours) test of
the web app against Come and See's real workflow, before we move any users off the desktop
Codex app. This is a draft for team consideration — refine before sending.

**How to read the status flags:**

- ✅ **Should work today** — test it; if it fails, that's a bug to file.
- 🚧 **Pending / not ready** — do **not** test as working yet; listed so we agree on the gap.
- ❓ **Decision needed** — behavior exists but we need Come and See's input on how it should work.

**Role ladder (for reference):** Viewer (100) · Commenter (200) · Reviewer (300) ·
Contributor (400) · Project Lead (500) · Maintainer (600) · Owner (700).
"Contributor" is the everyday translator role (≈ the old GitLab "developer").

---

## 1. Accounts & login

- [ ] ✅ Anna can log in as herself (Owner/Maintainer) and see the org.
- [ ] ✅ Anna can sign in as multiple accounts and switch between them (to spot-check what
      each translator sees).
- [ ] ✅ A translator can log in with a username + password Anna set up.
- [ ] ❓ **Username/password is locked down.** Come and See tracks every translator's
      credentials centrally and does **not** want users self-changing them (it breaks support).
      Confirm: a Contributor cannot change their own username. Decide whether self-service
      password reset should also be disabled in favor of an Anna-managed reset.

## 2. Org, teams & project visibility *(the core permissions test)*

> This is the section Wendi cares most about: translators should see only their own work;
> Anna/managers should see everything.

- [ ] 🚧 **A Contributor sees only the projects they're on** (via a team or direct
      assignment) — **not** every project in the org. *Status: a fix is in progress; until it
      lands, contributors can currently see all org projects. Re-test once notified.*
- [ ] ✅ A Maintainer/Owner (Anna) sees **all** projects in the org for oversight.
- [ ] ✅ Teams (formerly the GitLab subgroups like `the-chosen / Arabic-Moroccan`) exist, each
      with members + the projects they grant access to.
- [ ] ✅ Adding a translator to a team gives them access to that team's projects.
- [ ] ✅ Each member's role (Contributor / Project Lead / Maintainer / Owner) is visible and
      editable by Anna.
- [ ] ✅ Permission checks are live — if Anna changes someone's role, their ability to act
      changes immediately (no re-login).

## 3. Assignments & deadlines *(Anna's PM workflow)*

- [ ] ✅ Anna can set a project deadline.
- [ ] ✅ Anna can assign specific files (with timelines) to specific translators.
- [ ] ✅ A translator sees their own assignments and due dates (on-track / due-soon / overdue).
- [ ] ✅ Anna can see at-a-glance progress for a project, including audio progress where audio
      exists (e.g. "% complete", minutes recorded).

## 4. Sharing & invites

- [ ] ✅ Anna can add an existing org member to a project from inside the project.
- [ ] ✅ Anna can mint an invite link (requires Project Lead or higher to create).
- [ ] ✅ An invite link can only grant **Contributor** or lower — it cannot hand out
      Maintainer/Owner even if forwarded to the wrong person.
- [ ] ✅ An invite can be bound to an email and/or given an expiry, and can be revoked.

## 5. Translation editing

- [ ] ✅ A translator opens an assigned file and sees source + target cells.
- [ ] ✅ A translator can edit target cells and the edit persists (no manual sync step — Aquila
      has no offline/sync; a live connection is assumed).
- [ ] ✅ A translator sees who is speaking (cast/character) while translating.

## 6. Audio & voices

- [ ] ✅ A file with audio shows audio progress and recorded minutes.
- [ ] ✅ Switching to audio/voices view shows the recordings for the file.
- [ ] ✅ **Camera angle is a real, separate field on each cell** (`on` / `mixed` / `off`) —
      Wendi's lip-sync constraint — *not* just text glued onto the character name. Confirm the
      angle is visible to translators on both the subtitle and the audio side.
- [ ] ✅ Cast/voice assignment is independent of camera angle (a cell's voice and its camera
      angle are separate attributes).
- [ ] ✅ Export to subtitle (VTT) wraps cast-assigned cells in `<v Name>` voice tags, so
      speaker identity round-trips.

## 7. Character / cast labels & camera angle

- [ ] 🚧 **Importing character/cast labels onto existing cells is not available yet.** The
      template download and preview work, but *applying* labels is intentionally disabled
      (no safe server path yet — AQU-314). Do not test label import as working. The intended
      replacement is a **template project** (§9) that already carries the cast list.
- [ ] ❓ Come and See currently appends camera angle to the character name with three spaces +
      parentheses, e.g. `Mary Magdalene   (on)`. Since camera angle is already a separate field
      (§6), decide whether incoming data should be **split** into `voice = Mary Magdalene` +
      `camera = on` so translators can filter/export "all Mary lines" regardless of angle.

## 8. Export

- [ ] ✅ Export offers the formats Come and See needs (USFM, Word `.docx`, bilingual CSV/TSV,
      subtitle VTT, audio-by-character, etc.).
- [ ] ✅ **Export is permission-gated.** A Contributor (translator) cannot export; only the role
      Come and See chooses (configurable `exportMinRole`). Confirm the threshold matches policy.
- [ ] 🚧 **Custom file naming on export is not built yet.** Today exports use a fixed name
      derived from the file/project. The requested "save as / filename + optional timestamp +
      language" picker is pending.

## 9. Known-pending items & decisions *(don't test as working — listed for agreement)*

- [ ] 🚧 **Template project** — a copyable project that already carries the cast list and
      metadata, so labels aren't re-imported per project. (Replaces label import for setup.)
- [ ] 🚧 **Metadata spreadsheet export** — export a project's cast/metadata as a spreadsheet,
      with the project remaining the source of truth.
- [ ] 🚧 **File naming on export** (see §8).
- [ ] 🚧 **Character/cast label import apply** (see §7).
- [ ] 🚧 **Audio + subtitle in one project (timeline view)** — collapsing the current
      two-project workaround into a single timeline-ordered project with independent audio and
      subtitle tracks. A working model exists but the UI needs to be clearer (likely a
      horizontal, video-editor-style layout). Will be demoed separately, not part of this pass.
- [ ] ❓ **Mobile** — the web app is **laptop/desktop only** for editing at launch. Login and
      progress-checking may work on mobile, but translators should be told desktop/laptop only.

---

### What "pass" means for this round

Anna is verifying two things: **(1)** the permission boundaries are correct (translators see and
do only what they should; managers have oversight), and **(2)** her day-to-day PM workflow —
teams, assignments, deadlines, progress, export — is faster than the desktop app. The pending
items in §9 are expected gaps, not failures. Anything in a ✅ row that doesn't behave as written
is a bug to file.
