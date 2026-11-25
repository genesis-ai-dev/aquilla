# Lane-first Living Memory

Date: 2026-11-23 · Status: draft · Owner: Ryder · Related: AQU-2348 (PR #1784),
AQU-609 (lane-scoped rules), AQU-1509 (Rules lane picker), AQU-2719 (PR #2163,
settings as records), AQU-2351 / 2353 / 2354 / 2322 (lane permissions), AQU-2684
(lane in the URL)

Source: the team call of 2026-11-23, 09:52–09:59.

## Goal

Living Memory belongs to a language lane. A person works in one lane at a time. The
Living Memory page shows what applies to that lane, and nothing that applies only to
another lane. When the person changes lane, every part of the page changes with it.

Not everything in Living Memory relates to the lane in the same way. The page
separates four kinds of memory and uses one fixed label for each:

1. content that **belongs to a lane**,
2. content that is **shared by all lanes** of the project (or comes from the
   organization),
3. text that **adapts to each lane** by itself, because it is a template,
4. **project facts** that have nothing to do with a lane.

A project with one target lane looks the same as it does today.

Not in scope:

- Who may see or edit a lane. That is the permission work in AQU-2351, 2353, 2354
  and 2322. This spec only says where it connects (see "Permissions").
- The lane in the URL. That is AQU-2684 and AQU-2362.
- Copying one lane's memory to another lane.
- Per-lane AI provider and voice settings.

## What was said

- The lane filter in Living Memory "was tacked on". Living Memory depends on the lane
  completely. On a project with a French lane and a Spanish lane, the French rules
  must not appear on the Spanish lane.
- The lane must be a top-level selection ("which lane are you on?"), not a filter
  inside Living Memory.
- When the lane changes, everything that belongs to the lane changes at one time.
  Some settings do not depend on the lane, and they stay.
- A person assigned to one lane should see only that lane. Projects are not set up
  that way today.

## What exists today (on `dev` at `025f6f674`)

Each part of Living Memory has its own lane mechanism, or none:

| Part | Lane support on `dev` | How the lane is stored |
|---|---|---|
| Translation rules (`settings.rules`) | Yes. `rulesForLane` filters them for the editor, health and drafting | `scope: "lane"` + `lane` = the legacy tag (`''` = default lane) |
| Rules section of the page | A lane picker (`LaneCombobox`) inside this section only. Other lanes' rules stay in the list | The workspace `activeLane` |
| Built-in checks | Yes, on/off per lane | `algorithmicChecksByLane`, a map in the settings blob |
| Examples | Yes. The corpus is read in `activeLane` (AQU-2001) | The cell lane |
| Terminology | Renderings are per lane (`renderingsForLane`). It has its own page | Rendering rows |
| Instructions (`translationInstructions`) | No. One text for the project, read by every drafting path (AQU-2342, PR #1785) | Settings blob |
| AI role text (`DEFAULT_SYSTEM_PROMPT`) | Adapts by itself: `{sourceLanguage}` / `{targetLanguage}` are filled per lane | Fixed in code. A stored `systemPrompt` reaches no drafting prompt (AQU-2404) |
| Brief, instruction entries | Old sources. They are folded into Instructions on first read and are ignored after the first save | Settings blob |
| Style rules (`style_rules`) | No | Table, no lane column |
| Knowledge documents (`knowledge_docs`) | No | Table, no lane column |

So a person who changes lane sees the rules filter and the examples change, and
nothing else. This is the "tacked on" result.

## What PR #1784 does, and why it is not the answer

PR #1784 (AQU-2348) adds lane support to the five parts that have none. Its model is
"the project's memory, with lane exceptions":

- The project's brief and prompt are the default. A lane must use "Customize for this
  language lane" to own a copy, and "Revert to project" to drop it.
- While a lane inherits, an edit made in the lane view **writes the project's value**.
  All other lanes change too.
- Lists (entries, knowledge documents, style rules) are a union: the project's items
  plus the lane's.
- The style-rule library shows other lanes' rules with a badge. Management lists are
  not filtered by lane.
- The page gets a "Viewing language lane" picker.

This does not match the call:

1. Other lanes' rules are visible. The call asked for them to be absent.
2. The lane is still a control on the page, with its own vocabulary (inherit,
   customize, revert). The call asked for the lane to be the place the person is in.
3. A person in the Spanish lane can change the French lane's brief without a
   warning.
4. It adds two more storage shapes (`systemPromptByLane` / `translationBriefByLane`
   maps, and `laneId` on blob entries). Translation rules and built-in checks keep
   their own shapes. The page would have five lane mechanisms.
5. It gives lanes to the brief, the default prompt and the instruction entries. PR
   #1785 (AQU-2342) merged after it was written and retired all three: every drafting
   path now reads one Instructions text. Most of the PR's per-lane prose work has
   nothing left to attach to.

State of the PR on 2026-11-23:

- 1,704 commits behind `dev`. 20 files conflict.
- Its migration number 0196 is taken. `dev` is at 0206, and PR #2163 uses 0207.
- No browser has rendered its page. The QA box is not checked.
- PR #2163 (AQU-2719, open) moves `livingMemoryEntries` out of the settings blob to a
  `project_living_memory_entries` table, with the brief and the rules to follow. That
  table has no lane column. The PR #1784 blob shapes would have to be moved again.

## Design

### 0. Four kinds of memory

Today the page treats every section the same way, and PR #1784 gives each one the
same inherit / customize control. The sections are different, and the page must say
how.

| Kind | Label on the page | What it means | Parts | Lane control |
|---|---|---|---|---|
| Lane content | "Only Spanish" (the lane's name) | Written for one lane. Other lanes never see it | Lane instructions (section 4a), translation rules, style rules, terminology renderings, examples, language profile, orthography, built-in check settings | Can be shared with all lanes |
| Shared content | "All language lanes" | Written one time, applies in every lane | Project instructions, and the list parts above when a person shares them. Organization items show the organization badge | Can be kept for one lane only |
| Template | "Adapts to each language lane" | One fixed text with placeholders. The lane fills them | The AI's role text (`DEFAULT_SYSTEM_PROMPT` in `db/shared/translation-instructions.ts`): `{sourceLanguage}` and `{targetLanguage}` are replaced for each lane | None. See section 4 |
| Project fact | "Whole project" | A fact about the project or its source. A lane cannot change it | Document genres, source knowledge documents, AI provider and model | None |

Rules for the labels:

- Each index row and each pane header shows exactly one of the four labels, or a
  count of the first two ("Only Spanish · 12", "All language lanes · 3").
- The words are fixed. No pane uses "inherit", "customize", "override" or "revert".
- A template never shows a shared / lane choice. It is not shared content that a
  lane might copy; it is already correct for every lane.
- A project fact never shows a lane control, in any view.

### 1. One scope for every item

This section applies to lane content and shared content.

Every such item has one scope:

| Scope | Applies in | Stored as |
|---|---|---|
| Lane | That lane only | `lane_id` = the lane's id |
| All lanes | Every lane of the project | `lane_id` is NULL |
| Organization | Every project of the organization | As today |

Rules:

- The key is always `lanes.id` (the 8-hex id). It is never a language or a legacy
  tag. Translation rules move from `lane` (tag) to the lane id.
- A row with no lane is an "all lanes" row. All rows that exist today are "all lanes"
  rows, so nothing needs a backfill.
- An organization row never has a lane.
- One function answers "does this item apply in this lane?", in two forms: a SQL
  filter and an in-memory filter. PR #1784 has both (`laneRowFilterSql`,
  `laneScopedRows`) with a test that they agree. Keep them.

### 2. The page is in a lane

- Living Memory opens in the workspace's active lane. The page header names the lane
  ("Living Memory · Spanish"). The lane control is the workspace's lane switcher, the
  same `LaneCombobox` as the editor. The page has no second lane control, and the
  Rules section loses its own.
- Each part shows the items that apply in the lane: the lane's items, then "all
  lanes" items, then organization items. Items of other lanes are not shown.
- An "all lanes" item has a badge ("All language lanes"). An organization item has
  the organization badge it has today. A lane item has no badge.
- A maintainer can choose "All language lanes" in the lane switcher while on this
  page. That view lists every item with its lane name. It replaces the annotated
  lists of PR #1784. It is the only place where another lane's item is visible.
- A project with one target lane has no lane name in the header, no badges and no
  "All language lanes" view. The source lane does not count as a second lane.

### 3. Writes say where they go

- A new item belongs to the current lane. The create form has a control "Also apply
  to all language lanes", off by default. In the "All language lanes" view, a new
  item applies to all lanes.
- An edit of a lane item changes the lane item.
- An edit of an "all lanes" item, made from a lane, asks before it saves: "Change for
  all language lanes" or "Change for this language lane only". The second answer
  makes a lane copy and leaves the shared item alone. An edit never changes other
  lanes without this question.
- An item menu has "Apply to all language lanes" (lane → all) and "Keep for this
  language lane only" (all → lane).

### 4. The AI's role text is project-wide and adapts by itself

Decided 2026-11-23 (Ryder): the prompt is project-wide. A lane does not get its own
prompt.

This is also the state of `dev`. Since AQU-2342 the role text is fixed in code
(`DEFAULT_SYSTEM_PROMPT`), and `{sourceLanguage}` / `{targetLanguage}` are filled for
each lane when a prompt is built. A stored `systemPrompt` reaches no drafting prompt
(AQU-2404).

- The page does not offer the role text for editing.
- "What the AI receives" (section 4b) shows it with the lane's languages filled in
  and highlighted, under the label "Adapts to each language lane".
- The per-lane prompt of PR #1784 (`systemPromptByLane`) is dropped, with no
  replacement.

### 4a. Instructions: one project text, plus one text per lane

Instructions are the one place a team writes how the AI should translate (AQU-2342).
Today that is one text for the project, `settings.translationInstructions`. Every
drafting path reads it: the copilot, the prompt preview, the agent and Autopilot.

Adapting the AI for a lane must be easy, so the Instructions pane gets a second box:

- **"For every language lane"**: the project text that exists today. Label: "All
  language lanes".
- **"Only for Spanish"**: a text for the current lane. It is empty until someone
  writes in it. Label: "Only Spanish". The empty box has one line of help, for
  example "Tone, audience and wording that apply to Spanish only."
- Both boxes are on the pane at the same time, the project box first. A person does
  not choose a mode, copy anything or answer a question. Typing in a box is the whole
  action.
- "Help me write this" (the brief interview) asks which box its result goes to. On a
  project with more than one lane the lane box is selected, because the interview is
  mostly about the audience.
- A drafting prompt for a Spanish cell gets the project text, then the Spanish text,
  in one block at the position `instructionsPromptBlock` uses today. Other lanes'
  texts are never sent.
- If the two texts disagree, the lane text is the more specific one. The block says
  so in a short fixed line before the lane text ("For Spanish specifically:").
- The size ceiling (`TRANSLATION_INSTRUCTIONS_MAX_CHARS`, 8,000) applies to the sum of
  the two texts for a lane. The pane shows one counter.
- Server-side appends (an Autopilot decision card, an approved agent decision) go to
  the lane text when the run was in a lane, and to the project text when it was not.
- The save guard of today (`expect`, "Load latest" / "Save mine anyway") applies to
  each box separately.
- A one-lane project shows one box, as today.

Storage: a text per (project, lane), keyed by `lanes.id`, with the project text where
it is today. It follows AQU-2719 if Instructions move to a record. No copy of the
project text is made for a lane, so there is nothing to keep in sync and nothing to
revert.

The old sources (brief, instruction entries, a customized `systemPrompt`) get no lane
support. They are read only to fill the project box on a project that has never
saved Instructions.

### 4b. "What the AI receives for Spanish"

The kinds combine into one prompt. The page shows the result, so a person does not
have to work it out.

- A page-level action opens the assembled memory for the current lane: the role text
  with the lane's languages filled in, the project instructions, the lane
  instructions, the rules and the terms, each with its label.
- It reads from the same resolver as the Agent API prompt preview
  (`sync-worker/src/external/prompt-preview.ts`), so it shows what a draft call
  sends.
- It is read-only. Each editable part links to its pane.

### 5. What changes with the lane, and what does not

| Kind | On a lane change |
|---|---|
| Lane content | Replaced by the new lane's items |
| Shared content | Stays, with its "All language lanes" badge |
| Template | Stays the same text; the filled words change to the new lane's languages |
| Project fact | Stays. No visible change |

Terminology keeps its own page. It opens in the same active lane.

Knowledge documents: a document about the source (a commentary, a source glossary)
is a project fact. A document about one audience (a French style guide) is lane
content. The upload form asks one question, "Who is this for?", with "Every language
lane" selected. This is the one part where a new item does not default to the
current lane.

### 6. Readers

Every reader that builds a prompt or runs a check for a cell resolves memory for the
cell's lane through one resolver: the copilot, Autopilot, the health checks, the
server-side draft and the Agent API prompt preview. The preview must report what the
draft call sends (the AQU-1230 contract). A reader that names no lane gets "all
lanes" and organization items only.

### 7. Agent API

- The instructions write, and style-rule and knowledge writes, take an optional
  `laneId`. Without it, the write is an "all lanes" write, as today.
- `SetBrief` and `RegenerateBriefSummary` get no lane argument. A brief change may
  not reach the AI at all once Instructions are saved (AQU-2425).
- List reads take an optional `laneId` and return what applies in that lane. Each
  item reports its scope.

### 8. Permissions

This spec keeps today's edit floors (MAINTAINER for settings, PROJECT_LEAD for
knowledge). When lane roles exist (AQU-2353), a Lane lead edits that lane's items, and
"all lanes" writes need a project-level role. The "All language lanes" view and the
"Change for all language lanes" answer are the two places that need the project-level
check.

## What to do with PR #1784

Do not merge it. Close it after the first slice below lands, and say why on AQU-2348.

Keep (port onto current `dev`):

- `db/shared/lane-memory.ts`: the row filter in both forms, `targetLaneIdForTag`, the
  lane-key validator. Drop the `*ByLane` map writers.
- The nullable `lane_id` on `knowledge_docs` and `style_rules`, the CHECK that only a
  project row may name a lane, and the partial indexes. New migration number.
- The lane argument on `createDoc`, `searchKnowledge`, `createRule`,
  `listRulesForProject`.
- The lane-aware readers: `loadProjectContext`, `/api/v1/ai/agent/run`, the internal
  `DraftCells` endpoint, `prompt-preview`.
- The archive test: archiving a lane keeps its memory.
- Its tests for all of the above.

Drop:

- Slice 4 (the page, `LaneMemorySection`, `lane-sections.ts`).
- "Annotated, not filtered" lists.
- The silent project-wide write from a lane view.
- The settings keys `systemPromptByLane` and `translationBriefByLane`, and `laneId` on
  instruction entries. All three are lane versions of sources that AQU-2342 retired.

## Slices

1. **Storage and readers.** Port the "keep" list. Add the lane instructions text and
   make every drafting path send project text + lane text. No UI change. Every
   existing project reads as before. PR #2163 only matters here if it moves
   Instructions to a record before this slice lands.
2. **The page in a lane.** Header, filtering, the four labels, the "All language
   lanes" view, removal of the Rules-section picker. The Instructions pane gets its
   second box.
3. **Writes.** The create control, the edit question and the item menu for rules,
   style rules and knowledge documents.
3a. **"What the AI receives for Spanish".**
4. **One key.** Move translation rules from the lane tag to the lane id, and
   `algorithmicChecksByLane` into the same scope model. Until this slice, both keep
   their current storage and are filtered by the same active lane on the page.
5. **Agent API** list reads and scope reporting.

Each slice with UI is checked in a browser on the dev stack with a two-lane project
before it is called done. PR #1784 skipped this.

## Open decisions

1. ~~Default for a new item: this lane, or all lanes?~~ **Decided 2026-11-23 (Ryder):
   this lane.** Knowledge documents are the stated exception (section 5).
2. ~~Is the brief shared until a lane changes it?~~ **No longer a question.** The
   brief is not a separate part since AQU-2342. Project instructions apply to every
   lane and lane instructions add to them (section 4a). Nothing is copied.
3. **Does the "All language lanes" view exist for Project leads, or only for
   Maintainers and above?**
4. **Order against PR #2163.** If it merges without lane columns, slice 1 adds them
   in a second migration.
5. ~~Does a separate prompt for one lane stay possible?~~ **Decided 2026-11-23
   (Ryder): no.** The prompt is project-wide. A lane is adapted through lane
   instructions (section 4a).
6. ~~Where do server-side appends go?~~ **Decided 2026-11-23 (Ryder): the lane's
   text.** An Autopilot or agent decision made in a lane is saved to that lane's
   instructions. A decision made with no lane goes to the project text, as today.

## Acceptance for the template and the labels

- "What the AI receives" reads "…into Spanish" in the Spanish lane and "…into French"
  in the French lane, with the language highlighted. No one edited anything between
  the two.
- No pane offers a per-lane prompt.
- Text typed in "Only for Spanish" reaches a Spanish draft and not a French draft.
  Text in "For every language lane" reaches both.
- Writing a lane instruction takes one action: type in the box.
- Every index row and pane header shows one of the four labels.
- "What the AI receives for Spanish" matches the Agent API prompt preview for a
  Spanish cell.

## Acceptance

On a project with French and Spanish target lanes:

- In the Spanish lane, no French-only rule, style rule, entry or knowledge document
  appears on any pane, in the editor, in a health check or in a drafted prompt.
- Changing the lane in the workspace changes every pane of Living Memory, with no
  second control.
- A rule made in the Spanish lane does not apply in French until "Apply to all
  language lanes" is used.
- An edit of a shared rule from the Spanish lane asks which lanes it changes. "This
  language lane only" leaves the rule unchanged in French.
- The prompt preview for a Spanish cell reports the same memory that the draft call
  sends.
- Archiving and restoring a lane keeps its memory.
- A one-lane project shows no lane name, badge or scope control in Living Memory.
