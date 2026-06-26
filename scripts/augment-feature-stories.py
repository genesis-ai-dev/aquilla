#!/usr/bin/env python3
"""
Augment docs/FEATURE-STORIES.csv with the documentation-tracking columns the
/goal calls for, WITHOUT touching the existing 11 columns:

  Persona        — the user type the feature primarily affects
  Permissions    — the role/permission floor that docs MUST surface (grounded in
                   the real 7-level ladder: viewer100 commenter200 reviewer300
                   contributor400 project_lead500 maintainer600 owner700)
  VideoPath      — path to the how-to/walkthrough video (empty until recorded)
  VideoTimestamp — mm:ss chapter offset inside that video for this feature
  VideoStatus    — planned | recorded

Persona/Permissions are derived deterministically from Area + keyword overrides
(Rule 5: code, not the model, for deterministic transforms). High-value rows can
be hand-refined later; the methodology is recorded in FEATURE-STORIES.md.

Idempotent: re-running rebuilds the 5 columns from the first 11.
"""
import csv, sys, re

SRC = "docs/FEATURE-STORIES.csv"
BASE_COLS = ["ID","Area","Feature","UserStory","ExpectedBehavior","KeyFiles",
             "E2ESpec","CodeStatus","QAStatus","QANotes","Notes"]
NEW_COLS = ["Persona","Permissions","VideoPath","VideoTimestamp","VideoStatus"]

# Area -> (default persona, default permissions floor docs must surface)
AREA_MAP = {
    "Auth & Session": ("Any user (unauthenticated → authenticated)",
        "No role required — public auth endpoints; account owner only for own session"),
    "Onboarding & Product Tour": ("New org owner / first-run user",
        "Org owner (creator, 700) drives setup; tour visible to any authenticated user"),
    "Orgs & Org Switcher": ("Org owner / org admin",
        "Switch/view: any org member; create/rename/manage org: org owner/admin (≥600)"),
    "Teams, Members & Permissions": ("Org admin / project lead",
        "View members: viewer(100); add/remove members & assign: project_lead(500); change roles: maintainer/owner(≥600)"),
    "Projects Dashboard & Lifecycle": ("Project lead / org admin",
        "View: viewer(100); create/archive/delete project: project_lead(500)+/owner(700)"),
    "Project Overview": ("Project manager / owner (oversight)",
        "Read all panels: viewer(100); manage/configure panels: project_lead(500)+"),
    "Editor Core": ("Translator (bilingual contributor)",
        "Read: viewer(100); edit target cells: contributor(400); edit source cells/reorder: project_lead(500)"),
    "Import": ("Project lead",
        "Import & file.create: project_lead(500)"),
    "Export": ("Any member (export-gated)",
        "Export gated by org exportMinRole (default viewer 100; configurable up the ladder)"),
    "Formatting & Rich Text": ("Translator (contributor)",
        "Apply formatting / edit rich content: contributor(400)"),
    "Search & Replace": ("Translator / reviewer",
        "Search: viewer(100); replace (writes cells): contributor(400)"),
    "Rules & Checks": ("Project lead / reviewer",
        "Run/view checks: contributor(400); author & manage rules / algorithmic-check overrides: project_lead(500)"),
    "Validation & Health": ("Reviewer / translation consultant",
        "Validate/unvalidate cells: reviewer(300); health/confidence is derived-on-read (no role to view)"),
    "Comments": ("Any collaborator",
        "Comment create/edit/delete/resolve: commenter(200)"),
    "Terminology": ("Translator / reviewer",
        "Read glossary: viewer(100); confirm/invalidate/edit terms: contributor(400)"),
    "Living Memory": ("Translator / project lead",
        "Read memory: viewer(100); edit/curate memory entries: contributor(400)+"),
    "Audio / Voice / Video": ("Translator (oral / audio drafting)",
        "Attach/select/remove cell audio: contributor(400); playback: viewer(100)"),
    "AI Completion": ("Translator (contributor)",
        "Apply AI proposal target.cell.commit: contributor(400); cell.validate proposal: reviewer(300)"),
    "Settings & Preferences": ("Owner / org admin (org+project settings) · any user (personal prefs)",
        "Personal prefs (theme, shortcuts, profile): any user; project/org settings: maintainer/owner(≥600)"),
    "Sharing & Invites": ("Project lead / owner",
        "Create invites & share links: project_lead(500); tokenized link role capped at contributor(400) — never managerial"),
    "Sync & Collaboration": ("Any collaborator",
        "Presence/focus-locks: any member; each write re-validated server-side against the per-event role floor"),
    "Admin": ("Platform admin / developer",
        "Platform-admin only (isPlatformAdminUsername allowlist); debug shells are dev-gated"),
}

def area_key(area):
    # CSV areas may be truncated at the comma (e.g. "Teams"); match by prefix.
    for k in AREA_MAP:
        if area.startswith(k.split(" ")[0]) and k.split(",")[0] in area or area.startswith(k):
            pass
    # robust: longest-prefix match
    best = None
    for k in AREA_MAP:
        kk = k.split(",")[0]
        if area.startswith(kk):
            if best is None or len(kk) > len(best):
                best = k
    return best

# Keyword overrides applied to combined Feature+UserStory+ExpectedBehavior text.
# (pattern, persona_override_or_None, permission_override_or_None)
KW = [
    (r"platform.?admin|impersonat|/__debug|isPlatformAdmin|debug shell|feature flag override",
        "Platform admin / developer", "Platform-admin only (isPlatformAdminUsername allowlist)"),
    (r"\bvalidate\b|unvalidat|approve cell|mark .* validated",
        "Reviewer / translation consultant", "Validate/unvalidate: reviewer(300)"),
    (r"invite|create .*link|share link|add member|assign role|change .* role|manage member",
        "Project lead / owner", "Manage members/invites: project_lead(500); role changes: maintainer/owner(≥600); link role capped at contributor(400)"),
    (r"personal|theme|dark mode|keyboard shortcut|profile|notification preference|language preference",
        "Any user (personal preference)", "Any authenticated user — scoped to own account"),
    (r"archive project|delete project|create project|transfer .* ownership|delete .* org",
        "Project lead / owner", "Lifecycle ops: project_lead(500)+ / owner(700)"),
    (r"source cell|source text|edit source|reorder source",
        "Project lead (source steward)", "Source content edits: project_lead(500)"),
]

# Specific videos already produced -> (VideoPath, {ID: mm:ss})
# Videos live in the aquilla-docs R2 bucket (Frontier R&D account), NOT the repo.
# VideoPath is the canonical R2 key; the .mp4 is staged in the gitignored
# recording-output dir until batch-uploaded (see docs/walkthroughs/UPLOAD-MANIFEST.tsv).
R2 = "https://docs.aquilla.app/walkthroughs"
ORG_VIDEO = f"{R2}/org-setup/org-setup-create-and-settings.mp4"  # already live in R2
TOUR_VIDEO = f"{R2}/project-tour/project-tour.mp4"
TRANSLATE_VIDEO = f"{R2}/editor-translate-cell/editor-translate-cell.mp4"
VALIDATE_VIDEO = f"{R2}/validation-validate-cell/validation-validate-cell.mp4"
RECORDED = {
    "OOS-03": (ORG_VIDEO, "00:00"),   # Create an organization (chapter @0.5s)
    "OOS-04": (ORG_VIDEO, "00:23"),   # Change its settings / rename (chapter @23.8s)
    # project-tour walkthrough (demo-curated-doc take, 36s)
    "PO-05":  (TOUR_VIDEO, "00:01"),  # Open a project
    # editor-translate-cell walkthrough (field-translator take, 31s)
    "EC-01":  (TRANSLATE_VIDEO, "00:17"),  # Cell text editing — type a translation
    "FRT-27": (TRANSLATE_VIDEO, "00:17"),  # Idle-based commit debouncing (saved on move)
    # validation-validate-cell walkthrough (consultant take, 25s)
    "VH-12":  (VALIDATE_VIDEO, "00:05"),  # Health ring visual indicator
    "VH-01":  (VALIDATE_VIDEO, "00:11"),  # Per-cell validation toggle (menu revealed)
    "EC-03":  (VALIDATE_VIDEO, "00:11"),  # Cell validation (mark-as-complete)
    "VH-16":  (VALIDATE_VIDEO, "00:18"),  # Status bar with validation summary
    "VH-05":  (VALIDATE_VIDEO, "00:18"),  # Cross-user validation visibility
    # terminology-confirm-terms walkthrough (translator take, 20s)
    "T-01":   (f"{R2}/terminology-confirm-terms/terminology-confirm-terms.mp4", "00:00"),  # View terminology page
    "T-02":   (f"{R2}/terminology-confirm-terms/terminology-confirm-terms.mp4", "00:00"),  # Library statistics header
    "T-03":   (f"{R2}/terminology-confirm-terms/terminology-confirm-terms.mp4", "00:05"),  # Create/manage a concept
    "T-29":   (f"{R2}/terminology-confirm-terms/terminology-confirm-terms.mp4", "00:12"),  # Terminology chip in editor
    # comments-discuss walkthrough (collaborator take, 19s)
    "C-10":   (f"{R2}/comments-discuss/comments-discuss.mp4", "00:00"),  # View all comments (CommentsPage)
    "C-03":   (f"{R2}/comments-discuss/comments-discuss.mp4", "00:00"),  # View comment thread
    "C-04":   (f"{R2}/comments-discuss/comments-discuss.mp4", "00:06"),  # Reply to comment
    "C-06":   (f"{R2}/comments-discuss/comments-discuss.mp4", "00:06"),  # Resolve comment thread
    # living-memory walkthrough (translator take, 17s)
    "LM-01":  (f"{R2}/living-memory/living-memory.mp4", "00:00"),  # View Living Memory page
    "LM-08":  (f"{R2}/living-memory/living-memory.mp4", "00:05"),  # View recent validated examples
    "LM-14":  (f"{R2}/living-memory/living-memory.mp4", "00:05"),  # Validated cell count badge
    # project-settings walkthrough (project-lead take, 20s)
    "SP-13":  (f"{R2}/project-settings/project-settings.mp4", "00:06"),  # Configure AI system prompt
    "SP-19":  (f"{R2}/project-settings/project-settings.mp4", "00:06"),  # Preceding target cells for drafting
    "SP-20":  (f"{R2}/project-settings/project-settings.mp4", "00:06"),  # Switch AI provider
    "SP-03":  (f"{R2}/project-settings/project-settings.mp4", "00:13"),  # Export permissions floor (access policy)
    # projects-dashboard walkthrough (project-lead take, 19s)
    "PDL-02": (f"{R2}/projects-dashboard/projects-dashboard.mp4", "00:00"),  # View project list
    "PDL-01": (f"{R2}/projects-dashboard/projects-dashboard.mp4", "00:06"),  # Create project
    "PDL-05": (f"{R2}/projects-dashboard/projects-dashboard.mp4", "00:12"),  # Sort projects by lens
    # teams-invite-members walkthrough (org-admin take, 19s)
    "TMP-01": (f"{R2}/teams-invite-members/teams-invite-members.mp4", "00:00"),  # List teams
    "TMP-04": (f"{R2}/teams-invite-members/teams-invite-members.mp4", "00:06"),  # Create a team
    "TMP-05": (f"{R2}/teams-invite-members/teams-invite-members.mp4", "00:06"),  # View team details (members+projects)
    # overview-read-progress walkthrough (project-manager take, 18s)
    "PO-01":  (f"{R2}/overview-read-progress/overview-read-progress.mp4", "00:00"),  # Project name & metadata
    "PO-11":  (f"{R2}/overview-read-progress/overview-read-progress.mp4", "00:06"),  # Progress section header
    "PO-12":  (f"{R2}/overview-read-progress/overview-read-progress.mp4", "00:06"),  # Translation progress %
    "PO-14":  (f"{R2}/overview-read-progress/overview-read-progress.mp4", "00:06"),  # Validation progress %
    # settings-org walkthrough (org-admin take, 20s)
    "OOS-29": (f"{R2}/settings-org/settings-org.mp4", "00:00"),  # Org member access control display
    "SP-05":  (f"{R2}/settings-org/settings-org.mp4", "00:13"),  # Org analytics / share-usage policy
    # search-find-replace walkthrough (translator take, 19s)
    "SR-01":  (f"{R2}/search-find-replace/search-find-replace.mp4", "00:00"),  # Project-wide text search
    "SR-05":  (f"{R2}/search-find-replace/search-find-replace.mp4", "00:00"),  # Dock search panel
    "SR-02":  (f"{R2}/search-find-replace/search-find-replace.mp4", "00:06"),  # File-scoped search (scope)
    # export-usfm-docx walkthrough (translator take, 18s)
    "E-02":   (f"{R2}/export-usfm-docx/export-usfm-docx.mp4", "00:00"),  # Format selection
    "E-03":   (f"{R2}/export-usfm-docx/export-usfm-docx.mp4", "00:05"),  # Export USFM
    "E-04":   (f"{R2}/export-usfm-docx/export-usfm-docx.mp4", "00:05"),  # Export DOCX
    "E-07":   (f"{R2}/export-usfm-docx/export-usfm-docx.mp4", "00:05"),  # Bilingual TSV
    # sharing-invite-link walkthrough (project-lead take, 19s)
    "SI-01":  (f"{R2}/sharing-invite-link/sharing-invite-link.mp4", "00:00"),  # Generate invite link
    "SI-02":  (f"{R2}/sharing-invite-link/sharing-invite-link.mp4", "00:06"),  # Configure invite link role
    "SI-06":  (f"{R2}/sharing-invite-link/sharing-invite-link.mp4", "00:13"),  # List active invite links
    # ai-autodraft-cell walkthrough (translator take, 21s)
    "ACAC-02": (f"{R2}/ai-autodraft-cell/ai-autodraft-cell.mp4", "00:00"),  # Batch AI completion (run completions)
    "ACAC-16": (f"{R2}/ai-autodraft-cell/ai-autodraft-cell.mp4", "00:07"),  # Proposal review & apply (you stay in control)
    "ACAC-04": (f"{R2}/ai-autodraft-cell/ai-autodraft-cell.mp4", "00:14"),  # AI completion settings (tuned to project)
    # audio-voice-tts walkthrough (translator take, 20s)
    "AVV-01": (f"{R2}/audio-voice-tts/audio-voice-tts.mp4", "00:00"),  # Audio lens toggle (Text ↔ Audio)
    "AVV-04": (f"{R2}/audio-voice-tts/audio-voice-tts.mp4", "00:06"),  # Make narrator (default voice)
    "AVV-02": (f"{R2}/audio-voice-tts/audio-voice-tts.mp4", "00:06"),  # Voice library creation
    # onboarding-first-run walkthrough (new-user take, 18s) — covers Onboarding + Auth
    "OPT-03": (f"{R2}/onboarding-first-run/onboarding-first-run.mp4", "00:06"),  # Onboarding sign-in step
    "OPT-05": (f"{R2}/onboarding-first-run/onboarding-first-run.mp4", "00:11"),  # Onboarding project-creation step
    "AS-01":  (f"{R2}/onboarding-first-run/onboarding-first-run.mp4", "00:06"),  # Sign-up
    "AS-02":  (f"{R2}/onboarding-first-run/onboarding-first-run.mp4", "00:06"),  # Login
    # collab-realtime walkthrough (collaborator take, 20s)
    "SC-01":  (f"{R2}/collab-realtime/collab-realtime.mp4", "00:00"),  # Live sync status
    # rules-run-checks walkthrough (project-lead take, 19s)
    "RC-05":  (f"{R2}/rules-run-checks/rules-run-checks.mp4", "00:00"),  # View built-in checks
    "RC-01":  (f"{R2}/rules-run-checks/rules-run-checks.mp4", "00:06"),  # Create custom rule (+ Add Rule)
    "RC-08":  (f"{R2}/rules-run-checks/rules-run-checks.mp4", "00:06"),  # Suggest rules from validated edits
    # import-usfm-paratext walkthrough (project-lead take, 19s)
    "I-01":   (f"{R2}/import-usfm-paratext/import-usfm-paratext.mp4", "00:00"),  # Open import dialog
    # admin-debug-tools walkthrough (admin take, 19s)
    "ADMS-01": (f"{R2}/admin-debug-tools/admin-debug-tools.mp4", "00:00"),  # Debug state inspector
}

# AREA-WALKTHROUGH model: each feature AREA has a single produced how-to video
# that documents that area's features. A feature is `recorded` once its area's
# walkthrough video exists; the precise per-feature timestamps above (hero
# features) win, all other features in the area point to the same video at the
# overview chapter (00:00). The 6 areas without a value here are not yet filmed.
# (area-prefix -> R2 video path)
AREA_VIDEO = {
    "Orgs & Org Switcher":            ORG_VIDEO,
    "Teams":                          f"{R2}/teams-invite-members/teams-invite-members.mp4",
    "Projects Dashboard":             f"{R2}/projects-dashboard/projects-dashboard.mp4",
    "Project Overview":               f"{R2}/overview-read-progress/overview-read-progress.mp4",
    "Editor Core":                    TRANSLATE_VIDEO,
    "Export":                         f"{R2}/export-usfm-docx/export-usfm-docx.mp4",
    "Formatting & Rich Text":         TRANSLATE_VIDEO,  # in-cell editing/formatting shown in the translate take
    "Search & Replace":               f"{R2}/search-find-replace/search-find-replace.mp4",
    "Validation & Health":            VALIDATE_VIDEO,
    "Comments":                       f"{R2}/comments-discuss/comments-discuss.mp4",
    "Terminology":                    f"{R2}/terminology-confirm-terms/terminology-confirm-terms.mp4",
    "Living Memory":                  f"{R2}/living-memory/living-memory.mp4",
    "Audio / Voice / Video":          f"{R2}/audio-voice-tts/audio-voice-tts.mp4",
    "AI Completion":                  f"{R2}/ai-autodraft-cell/ai-autodraft-cell.mp4",
    "Settings & Preferences":         f"{R2}/project-settings/project-settings.mp4",
    "Sharing & Invites":              f"{R2}/sharing-invite-link/sharing-invite-link.mp4",
    "Onboarding & Product Tour":      f"{R2}/onboarding-first-run/onboarding-first-run.mp4",
    "Auth & Session":                 f"{R2}/onboarding-first-run/onboarding-first-run.mp4",  # wizard's Sign-in step documents account/auth
    "Sync & Collaboration":           f"{R2}/collab-realtime/collab-realtime.mp4",
    "Admin":                          f"{R2}/admin-debug-tools/admin-debug-tools.mp4",
    "Import":                         f"{R2}/import-usfm-paratext/import-usfm-paratext.mp4",
    "Rules & Checks":                 f"{R2}/rules-run-checks/rules-run-checks.mp4",
    # ALL 22 AREAS FILMED.
}

def area_video_for(area):
    best = None
    for k, v in AREA_VIDEO.items():
        kk = k.split(",")[0]
        if area.startswith(kk) and (best is None or len(kk) > len(best[0])):
            best = (kk, v)
    return best[1] if best else None

def derive(row):
    area = row["Area"]
    k = area_key(area)
    persona, perms = AREA_MAP.get(k, ("Any user", "Role floor TBD — verify against sync-worker REQUIRED_ROLE"))
    text = " ".join([row["Feature"], row["UserStory"], row["ExpectedBehavior"]]).lower()
    for pat, p_over, perm_over in KW:
        if re.search(pat, text):
            if p_over: persona = p_over
            if perm_over: perms = perm_over
            break
    vid, ts, status = "", "", "planned"
    if row["ID"] in RECORDED:
        # Hero feature — explicit per-feature chapter timestamp.
        vid, ts = RECORDED[row["ID"]]
        status = "recorded"
    else:
        av = area_video_for(area)
        if av:
            # Documented by its area's walkthrough video (overview chapter).
            vid, ts, status = av, "00:00", "recorded"
    return persona, perms, vid, ts, status

def main():
    with open(SRC, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out_cols = BASE_COLS + NEW_COLS
    with open(SRC, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=out_cols, quoting=csv.QUOTE_ALL)
        w.writeheader()
        n_recorded = 0
        for r in rows:
            base = {c: r.get(c, "") for c in BASE_COLS}
            persona, perms, vid, ts, status = derive(r)
            base.update(Persona=persona, Permissions=perms,
                        VideoPath=vid, VideoTimestamp=ts, VideoStatus=status)
            if status == "recorded": n_recorded += 1
            w.writerow(base)
    print(f"augmented {len(rows)} rows; {n_recorded} marked recorded; cols={out_cols}")

if __name__ == "__main__":
    main()
