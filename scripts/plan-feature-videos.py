#!/usr/bin/env python3
"""
Build the walkthrough-video CATALOG and assign every feature row to exactly one
planned how-to video. Writes the planned VideoPath into FEATURE-STORIES.csv
(without disturbing already-`recorded` rows) and emits FEATURE-VIDEOS-PLAN.md.

A "walkthrough" = one shootable doc-mode take (Showcase harness). Big areas are
split into several takes; each take claims feature rows by keyword, with an
area-level catch-all so coverage is total. Run AFTER augment-feature-stories.py.
Idempotent.
"""
import csv, re, collections

SRC = "docs/FEATURE-STORIES.csv"
PLAN = "docs/FEATURE-VIDEOS-PLAN.md"

# Videos live in the aquilla-docs R2 bucket (Frontier R&D acct), NOT the repo.
R2 = "https://docs.aquilla.app/media"
# Slugs already satisfied by an existing recorded asset reuse that path.
SPECIAL_PATH = {
    "org-create-and-settings": f"{R2}/org-setup/org-setup-create-and-settings.mp4",
}

def slugpath(slug):
    return SPECIAL_PATH.get(slug, f"{R2}/{slug}/{slug}.mp4")

# Catalog: area-prefix -> list of takes.
# Each take = (slug, title, persona, keyword-regex-or-None). None = area catch-all
# (must be LAST in the list). Order matters: first matching take wins.
CATALOG = {
 "Auth & Session": [
   ("auth-signup-login","Sign up & log in","New / returning user",
     r"sign.?up|log ?in|password|account switch|sign.?in|register"),
   ("auth-session-recovery","Sessions, recovery & sign-out","Any user", None),
 ],
 "Onboarding & Product Tour": [
   ("onboarding-first-run","First-run onboarding wizard","New org owner",
     r"onboarding|wizard|first.?run|welcome|get started"),
   ("onboarding-product-tour","Product tour & setup checklist","New org owner", None),
 ],
 "Orgs & Org Switcher": [
   ("org-create-and-settings","Create an org & change its settings","Org owner / admin",
     r"create .*org|rename .*org|org .*setting|switch .*org|organizations? list"),
   ("org-switcher-cross-org","Org switcher & cross-org overview","Org owner / admin", None),
 ],
 "Teams, Members & Permissions": [
   ("teams-invite-members","Invite & manage team members","Org admin / project lead",
     r"invite|add member|remove member|member access"),
   ("teams-roles-permissions","Assign roles & understand permissions","Org admin / owner", None),
 ],
 "Projects Dashboard & Lifecycle": [
   ("projects-create-open","Create & open a project","Project lead",
     r"create project|open project|new project|project card"),
   ("projects-lifecycle","Archive, restore & manage projects","Project lead / owner", None),
 ],
 "Project Overview": [
   ("overview-read-progress","Read a project's overview & progress","Project manager / owner",
     r"progress|overview|panel|metric|stat|chart|burndown"),
   ("overview-manage","Configure the project overview","Project lead", None),
 ],
 "Editor Core": [
   ("editor-translate-cell","Translate a cell in the editor","Translator",
     r"cell|edit|type|commit|draft|navigate"),
   ("editor-core-extras","Editor structure & navigation","Translator", None),
 ],
 "Import": [
   ("import-usfm-paratext","Import USFM / Paratext source","Project lead",
     r"usfm|paratext|ebible|source"),
   ("import-docx-obs-other","Import DOCX, OBS & other formats","Project lead", None),
 ],
 "Export": [
   ("export-usfm-docx","Export to USFM & DOCX","Any member",
     r"usfm|docx|word"),
   ("export-formats-options","Export formats & options","Any member", None),
 ],
 "Formatting & Rich Text": [
   ("formatting-rich-text","Format text & footnotes","Translator", None),
 ],
 "Search & Replace": [
   ("search-find-replace","Find & replace across the project","Translator / reviewer", None),
 ],
 "Rules & Checks": [
   ("rules-author","Author & suggest rules","Project lead",
     r"create rule|suggest rule|author|new rule|edit rule"),
   ("rules-run-checks","Run checks & fix flagged cells","Reviewer / translator", None),
 ],
 "Validation & Health": [
   ("validation-validate-cells","Validate cells as a reviewer","Reviewer / consultant",
     r"validate|approve|sign.?off"),
   ("validation-health-confidence","Read health & confidence signals","Project manager / owner", None),
 ],
 "Comments": [
   ("comments-discuss","Comment, reply & resolve","Any collaborator", None),
 ],
 "Terminology": [
   ("terminology-confirm-terms","Confirm & manage terminology","Translator / reviewer",
     r"confirm|invalidate|term|gloss|concept"),
   ("terminology-library","Browse the terminology library","Translator / reviewer", None),
 ],
 "Living Memory": [
   ("living-memory","Use & curate Living Memory","Translator / project lead", None),
 ],
 "Audio / Voice / Video": [
   ("audio-record-take","Record an audio take for a cell","Translator (oral)",
     r"record|take|microphone|audio.*attach|capture"),
   ("audio-voice-tts","Voices, TTS & playback","Translator", r"voice|tts|text.?to.?speech|playback|speak"),
   ("audio-video-extras","Audio/video management","Translator", None),
 ],
 "AI Completion": [
   ("ai-autodraft-cell","Auto-draft a cell with AI","Translator",
     r"complet|auto.?draft|suggest|generate|predict"),
   ("ai-agent-chat","Work with the AI agent & chat","Translator", None),
 ],
 "Settings & Preferences": [
   ("settings-project","Project settings & AI configuration","Project lead / owner",
     r"project setting|ai instruction|ai model|draft context|algorithmic"),
   ("settings-org","Org settings & access policy","Org admin / owner",
     r"org setting|export.?min|access policy|org name|billing"),
   ("settings-personal","Personal preferences","Any user", None),
 ],
 "Sharing & Invites": [
   ("sharing-invite-link","Share a project via link & invites","Project lead / owner", None),
 ],
 "Sync & Collaboration": [
   ("collab-realtime","Collaborate in real time (presence & locks)","Any collaborator",
     r"presence|focus.?lock|live|realtime|cursor|who"),
   ("collab-offline-sync","Offline edits & sync","Any collaborator", None),
 ],
 "Admin": [
   ("admin-debug-tools","Platform admin & debug tools","Platform admin / developer", None),
 ],
}

def area_match(area):
    best=None
    for k in CATALOG:
        kk=k.split(",")[0]
        if area.startswith(kk) and (best is None or len(kk)>len(best.split(',')[0])):
            best=k
    return best

def assign(row):
    area=area_match(row["Area"])
    if area is None: return None
    text=" ".join([row["Feature"],row["UserStory"],row["ExpectedBehavior"]]).lower()
    takes=CATALOG[area]
    for slug,title,persona,kw in takes:
        if kw is None:  # catch-all
            return slug
        if re.search(kw, text):
            return slug
    return takes[-1][0]

def main():
    rows=list(csv.DictReader(open(SRC, newline="", encoding="utf-8")))
    cols=list(rows[0].keys())
    cover=collections.Counter()
    for r in rows:
        if r["VideoStatus"]=="recorded":
            cover[r["VideoPath"]]+=1
            continue
        slug=assign(r)
        if slug:
            r["VideoPath"]=slugpath(slug)
            cover[slugpath(slug)]+=1
    with open(SRC,"w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f,fieldnames=cols,quoting=csv.QUOTE_ALL)
        w.writeheader(); w.writerows(rows)

    # Emit plan markdown
    take_meta={}
    for area,takes in CATALOG.items():
        for slug,title,persona,kw in takes:
            take_meta[slugpath(slug)]=(area,slug,title,persona)
    lines=["# Feature Videos — Walkthrough Plan","",
      f"Every one of the {len(rows)} features in `FEATURE-STORIES.csv` is assigned to one of "
      f"the **{len(take_meta)} walkthrough videos** below (its `VideoPath`). Each video is a "
      "doc-mode Showcase take (programmatic cursor + zoom + captions/chapters); each feature it "
      "covers gets a `VideoTimestamp` chapter offset once the take is recorded.","",
      "Record with the harness (see `.claude/skills/record-docs-video/`):",
      "```sh",
      "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev \\",
      '  npm run record -- -g "<take title>"',
      "npm run record:assemble -- --slug <persona>__<slug>","```","",
      "| # | Walkthrough | Area | Persona | Features | VideoPath | Status |",
      "| --: | --- | --- | --- | --: | --- | --- |"]
    i=0; shown=0
    for path,(area,slug,title,persona) in take_meta.items():
        n=cover.get(path,0)
        if n==0:  # zero-coverage take — keywords fully absorbed by a sibling; skip
            continue
        i+=1; shown+=1
        any_rec=any(r["VideoPath"]==path and r["VideoStatus"]=="recorded" for r in rows)
        any_plan=any(r["VideoPath"]==path and r["VideoStatus"]!="recorded" for r in rows)
        status="✅ recorded" if any_rec and not any_plan else ("🟡 partial" if any_rec else "⬜ planned")
        lines.append(f"| {i} | {title} | {area} | {persona} | {n} | `{path}` | {status} |")
    lines+=["", f"**Total: {shown} videos covering {len(rows)} features.** "
      "Org-setup take partially recorded (`docs/walkthroughs/org-setup/` — create + settings shown).",""]
    open(PLAN,"w",encoding="utf-8").write("\n".join(lines))
    print(f"assigned {len(rows)} features across {len(take_meta)} planned videos")
    print(f"wrote {PLAN}")

if __name__=="__main__":
    main()
