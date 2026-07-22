// L2 cookbooks for the translation agent (design §3 L2).
//
// Hand-written prose + SQL recipes, embedded in the worker at build time.
// Every recipe runs as-written against db/postgres/schema.sql (with :vars
// bound by sql-guard). Keep each cookbook under 200 lines; the model fetches
// one with execute({docs:"topic"}) only when a task needs it.

const DRAFTING = `# Drafting cookbook — the canonical draft loop

1. Find untranslated cells in the working file (empty target value):
SELECT c.cell_id, s.canonical_ref, s.value AS source_text
FROM cells c JOIN cells s
  ON s.project_id = c.project_id AND s.cell_id = c.cell_id AND s.side = 'source'
WHERE c.project_id = :project AND c.file_id = :file AND c.side = 'target'
  AND c.value = ''
ORDER BY s.canonical_ref LIMIT 40
(Note: source and target rows can live in different files but share cell_id;
the join above works when both sides are in the same file. If it returns
0 rows, find the paired file first — see files-and-refs.)

2. Pull nearby VALIDATED pairs as primary style/term evidence (these are the
ground truth for this language — imitate them, not general knowledge):
SELECT s.value AS source_text, t.value AS target_text, s.canonical_ref
FROM cells t JOIN cells s
  ON s.project_id = t.project_id AND s.cell_id = t.cell_id AND s.side = 'source'
WHERE t.project_id = :project AND t.side = 'target' AND t.validated = 1
  AND s.value_tsv @@ to_tsquery('simple', 'word1 | word2')
LIMIT 20
Build the tsquery from content words of the verse you are drafting
(OR-joined with |). Also check the termbase (docs: terminology).

3. Draft each cell, then stage:
emit: [{kind:'target.cell.commit', fileId:':file', cellId:'#c1',
        payload:{value:'drafted text'}}]
The server resolves parentId + sourceEventId, injects ai_suggestion +
agent_run_id, and pre-checks staleness. A 'stale' verdict means the cell
changed under you: re-read it (step 1 query with AND c.cell_id = '#c1')
and redraft from the current text.

4. Summarise for the user: how many staged, which refs, what evidence you used.`

const CHECKING = `# Checking cookbook — review a chapter / file

1. Overview of a file's state:
SELECT count(*) FILTER (WHERE value <> '') AS filled,
       count(*) FILTER (WHERE value = '') AS empty,
       count(*) FILTER (WHERE validated = 1) AS validated,
       count(*) FILTER (WHERE ai_drafted = 1) AS machine_drafted
FROM cells WHERE project_id = :project AND file_id = :file AND side = 'target'

2. Read source/target side by side for a chapter (scripture):
SELECT s.canonical_ref, s.value AS source_text, t.value AS target_text,
       t.validated, t.ai_drafted, t.cell_id
FROM cells s JOIN cells t
  ON t.project_id = s.project_id AND t.cell_id = s.cell_id AND t.side = 'target'
WHERE s.project_id = :project AND s.side = 'source'
  AND s.canonical_ref LIKE 'MRK 4:%'
ORDER BY s.canonical_ref

3. Stale cells (source changed after the target was committed — AD-9):
SELECT t.cell_id, s.canonical_ref, t.value AS target_text
FROM cells t JOIN cells s
  ON s.project_id = t.project_id AND s.cell_id = t.cell_id AND s.side = 'source'
WHERE t.project_id = :project AND t.file_id = :file AND t.side = 'target'
  AND t.source_event_id IS NOT NULL AND t.source_event_id <> s.event_id

4. Find parallel passages / consistency checks via full-text search:
SELECT file_id, cell_id, canonical_ref, value
FROM cells WHERE project_id = :project AND side = 'target'
  AND value_tsv @@ to_tsquery('simple', 'phrase & words')
LIMIT 30

5. Check waived rules before re-flagging something:
SELECT cell_id, rule_id, reason FROM cell_waivers
WHERE project_id = :project AND file_id = :file

6. Report findings as comments (COMMENTER+):
emit: [{kind:'comment.create', fileId:':file', cellId:'#c3',
        payload:{body:'Inconsistent rendering of X vs MRK 4:12 — consider Y.'}}]
Scope defaults to the cell; the server fills commentId. Deterministic rule
violations are re-checked client-side on every proposal card, so focus your
comments on judgment calls, not mechanical rules.`

const TERMINOLOGY = `# Terminology cookbook — the termbase and how to honour it

Concepts live in project_settings as JSON (key 'terminology'), not a table:
SELECT jsonb_array_length(settings::jsonb -> 'terminology' -> 'concepts') AS n
FROM project_settings WHERE project_id = :project

Pull the concepts (each has a gloss/renderings the project standardised on):
SELECT jsonb_array_elements(settings::jsonb -> 'terminology' -> 'concepts') AS concept
FROM project_settings WHERE project_id = :project
LIMIT 50
NEVER dump the whole termbase into an answer — select, then mention only the
top concepts matched against the text you are working on.

Where a term surfaces in the target text (inflection-tolerant via prefix
matching with :* in tsquery):
SELECT file_id, cell_id, canonical_ref, value
FROM cells WHERE project_id = :project AND side = 'target'
  AND value_tsv @@ to_tsquery('simple', 'stem:*')
LIMIT 30

Original-language morphology (Macula Hebrew/Greek files), e.g. all surface
forms of a lemma:
SELECT m.surface, m.lemma, m.morph_code, c.canonical_ref
FROM cell_word_morph m JOIN cells c
  ON c.project_id = m.project_id AND c.file_id = m.file_id
 AND c.cell_id = m.cell_id AND c.side = 'source'
WHERE m.project_id = :project AND m.lemma = 'λόγος'
LIMIT 50

Strong's lookups: cell_word_morph.strongs_h (Hebrew, 'H1234') / strongs_g
(Greek, 'G1234').

When drafting: render every termbase concept with the project's chosen
rendering. When checking: flag (comment.create) cells whose rendering
diverges from the termbase or from validated usage elsewhere.`

const VALIDATION = `# Validation cookbook — endorsements and the N-of-M gate

What "validated" means (answer this before running any query):
Validation is a HUMAN sign-off, not a quality score the machine assigns. A cell
is "validated" (validated=1) only after a person with REVIEWER+ explicitly
endorses its current text — never automatically. So a correct translation can
still show as "not validated", and that is expected, not a bug.

The case testers ask about most: "my AI translation is correct but shows as not
validated — why?" Because an AI draft is a suggestion, not a human judgment.
When the agent drafts a cell it is marked ai_drafted=1 and validated=0; leaving
it unchanged does NOT validate it. The expected workflow is that the translator
reviews the draft and, if it is correct as-is, clicks validate to endorse it —
validating an unedited-but-correct AI draft is exactly the intended step, not a
sign anything is wrong. Editing a cell clears ai_drafted (it is now human text)
but STILL does not validate it on its own; validated only flips when a reviewer
endorses it (or, on N-of-M projects, once enough reviewers do). So the three
states are distinct: ai_drafted (machine suggestion, unendorsed) → human-edited
(ai_drafted cleared, still unendorsed) → validated (a human signed off).
Never stage a validation on the user's behalf to "fix" this — see the emit note
below; only the human's own review validates a cell.

The project's validation threshold (how many validators a cell needs):
SELECT COALESCE(settings::jsonb ->> 'validationCountThreshold', '1') AS threshold
FROM project_settings WHERE project_id = :project

Who has validated a cell:
SELECT username, decided_ts FROM cell_validators
WHERE project_id = :project AND file_id = :file AND cell_id = '#c1'

Cells short of the threshold in a file:
SELECT c.cell_id, c.canonical_ref, c.value,
       (SELECT count(*) FROM cell_validators v
        WHERE v.project_id = c.project_id AND v.file_id = c.file_id
          AND v.cell_id = c.cell_id) AS validators
FROM cells c
WHERE c.project_id = :project AND c.file_id = :file AND c.side = 'target'
  AND c.value <> '' AND c.validated = 0
ORDER BY c.canonical_ref LIMIT 50

Staging a validation (REVIEWER+ — this endorses the CURRENT text):
emit: [{kind:'cell.validate', fileId:':file', cellId:'#c1', payload:{}}]
The server fills editEventId with the cell's current head event and reports
'stale' if the cell changed since you read it. Only stage validations for
cells the USER asked you to validate or has reviewed — a validation is a
human judgment you are recording on their behalf, never your own opinion.

Withdrawing: {kind:'cell.unvalidate', payload:{editEventId:'#e1'}}.
Note: validating clears ai_drafted; a human edit does too.`

const HISTORY = `# History cookbook — event-log archaeology

The events table is the full append-only log. payload is TEXT json — cast
with payload::jsonb. server_seq orders events project-wide; server_ts is ms.

What changed in a file this week:
SELECT kind, author, cell_id, server_ts
FROM events
WHERE project_id = :project AND file_id = :file
  AND server_ts > (extract(epoch from now() - interval '7 days') * 1000)
ORDER BY server_seq DESC LIMIT 100

A single cell's chain (newest first), with the text each commit wrote:
SELECT id, kind, author, parent_id, server_ts,
       payload::jsonb ->> 'value' AS value
FROM events
WHERE project_id = :project AND file_id = :file AND cell_id = '#c1'
ORDER BY server_seq DESC LIMIT 20
The CURRENT head is cells.event_id; events whose id never became a parent
and aren't the head are stale siblings (lost first-child races).

Who did what, project-wide:
SELECT author, kind, count(*) AS n
FROM events WHERE project_id = :project
  AND server_ts > (extract(epoch from now() - interval '30 days') * 1000)
GROUP BY author, kind ORDER BY n DESC LIMIT 50

Machine-drafted commits (AI provenance):
SELECT cell_id, author, server_ts, payload::jsonb ->> 'agent_run_id' AS run
FROM events
WHERE project_id = :project AND kind = 'target.cell.commit'
  AND payload::jsonb ->> 'ai_suggestion' = 'true'
ORDER BY server_seq DESC LIMIT 50

Live ai_drafted state (not yet human-touched): cells.ai_drafted = 1.`

const ASSIGNMENTS = `# Assignments cookbook — who is working on what

Active assignments:
SELECT a.assignment_id, u.username, a.scope_label, a.cells_total,
       a.deadline, a.note, a.completed_at
FROM assignments a JOIN users u ON u.id = a.assignee_user_id
WHERE a.project_id = :project AND a.unassigned_at IS NULL
ORDER BY a.created_at DESC LIMIT 50

Progress on one assignment (cells filled / validated within its scope):
SELECT count(*) AS total,
       count(*) FILTER (WHERE c.value <> '') AS filled,
       count(*) FILTER (WHERE c.validated = 1) AS validated
FROM assignment_cells ac JOIN cells c
  ON c.project_id = :project AND c.file_id = ac.file_id
 AND c.cell_id = ac.cell_id AND c.side = 'target'
WHERE ac.assignment_id = '#e1'
(assignment_id values come back from the first query; aliases work.)

Members you can assign to:
SELECT u.id, u.username, pm.role_level
FROM project_members pm JOIN users u ON u.id = pm.user_id
WHERE pm.project_id = :project ORDER BY pm.role_level DESC

Creating one (PROJECT_LEAD+). scopeKind 'books' = whole file(s);
'chapters' = chapter slices matched by canonical_ref prefix:
emit: [{kind:'assignment.create', payload:{
  assignmentId:'a-fresh-unique-id-string',
  scopeKind:'chapters', scope:[{fileId:'#f1', chapter:'GEN 1'}],
  scopeLabel:'Genesis 1', assigneeUserId: 42, deadline:'2026-07-01',
  note:'First pass draft'}}]
assignmentId must be a NEW unique id (never reuse one you read); confirm the
scope with the user before staging.`

const FILES_AND_REFS = `# Files & refs cookbook — project layout and canonical_ref grammar

List active files:
SELECT id, name, kind, role, book_code, cell_count, filled_count,
       approved_count, ai_drafted_count
FROM files WHERE project_id = :project AND deleted_at IS NULL
ORDER BY name LIMIT 100
- role: 'source' | 'target' (which side of the translation the file holds);
  source_file_id links a target file to its source counterpart.
- book_code: USFM 3-letter book id for scripture files (GEN, EXO … MAL,
  MAT, MRK, LUK, JHN … REV).

canonical_ref grammar (scripture cells): '<BOOK> <chapter>:<verse>', e.g.
'MRK 4:35'. Chapter slice: canonical_ref LIKE 'MRK 4:%'. Whole book:
LIKE 'MRK %'. Non-scripture media (CSV rows, subtitles) have canonical_ref
NULL — order those by the anchor chain or sequence_index instead.

Cell ordering: cells.anchor_cell_id points at the PREVIOUS cell_id in the
file (NULL = first cell). For subtitle/timeline files use start_ms/end_ms
or sequence_index.

Pair a target file with its source file:
SELECT t.id AS target_file, s.id AS source_file, t.name
FROM files t JOIN files s ON s.id = t.source_file_id
WHERE t.project_id = :project AND t.deleted_at IS NULL

Counters maintained by the projection (cheap overview without scanning
cells): files.cell_count, filled_count (non-empty targets), approved_count
(validated), ai_drafted_count, word_count, last_edit_at (ms).

Renaming a file label (CONTRIBUTOR+):
emit: [{kind:'file.rename', fileId:'#f1', payload:{name:'Mark (draft 2)'}}]
file.create / file.delete are structural (PROJECT_LEAD+) — propose only
when the user explicitly asks.`

const AQUIFER = `# Bible reference cookbook — bibletranslation.org scholarly data
Available only when the project enabled Bible resources. Use it to ground answers
about people, places, key terms, themes, and verse-level translation notes (from
9 scholarly sources) — NOT to invent project translations.

The loop:
1. Search for the entity or passage:
   execute({aquifer:{op:"search", q:"chesed Ruth 1:8"}})
   → titled results, each with a [kind] and a site path.
2. Read the best hit by its path:
   execute({aquifer:{op:"read", path:"/en/passages/RUT/1/8/"}})
   → the page's main text (translation notes, study notes, comparisons).
   Passage paths follow /en/passages/{USFM_BOOK}/{chapter}/{verse}/ — so a cell
   whose canonical_ref is "RUT 1:8" maps to /en/passages/RUT/1/8/.
3. Answer the user grounded in what you READ — quote/cite, don't paraphrase from
   memory. This is external scholarship; never treat it as a validated pair.
4. Optionally publish what you learned back to the wiki so it compounds:
   execute({aquifer:{op:"publish", question:"…", answer:"…", status:"answered",
            citations:[{url:"https://bibletranslation.org/en/terms/chesed/", quote:"…"}]}})
   Publishing STAGES a proposal (the user Applies it; it costs no credits) and
   needs ≥1 citation. Publish even when status:"undetermined" — explain why the
   sources were inconclusive.`

const BRIEF = `# Translation brief cookbook — the project's purpose & standards

The brief encodes WHY this translation exists and the standards it must meet
(skopos: audience, purpose, medium, register, literalness, key terms,
constraints). A short summary is already in your system card; fetch the FULL
brief only when a judgment call needs the detail behind the summary.

The brief lives in project_settings as JSON (key 'translationBrief'):
SELECT settings::jsonb -> 'translationBrief' ->> 'l1Summary'  AS summary,
       settings::jsonb -> 'translationBrief' ->> 'l2Markdown' AS full_brief,
       settings::jsonb -> 'translationBrief' -> 'parameters'  AS parameters
FROM project_settings WHERE project_id = :project

When drafting or checking, honour the brief: match the stated register and level
of literalness, apply the key-term strategy, and avoid anything the constraints
forbid. If the brief and a validated pair conflict, prefer the validated pair
(it is observed project practice) but flag the tension to the user.
If 'translationBrief' is null, the project has not authored a brief yet — say so
rather than inventing standards.`

const COOKBOOKS: Record<string, string> = {
  drafting: DRAFTING,
  checking: CHECKING,
  terminology: TERMINOLOGY,
  validation: VALIDATION,
  history: HISTORY,
  assignments: ASSIGNMENTS,
  "files-and-refs": FILES_AND_REFS,
  aquifer: AQUIFER,
  brief: BRIEF,
}

export const COOKBOOK_TOPICS = Object.keys(COOKBOOKS)

/** Fetch a cookbook by topic; unknown topics get a helpful listing. */
export function getCookbook(topic: string): { ok: boolean; text: string } {
  const text = COOKBOOKS[topic?.trim?.() ?? ""]
  if (text) return { ok: true, text }
  return {
    ok: false,
    text: `unknown cookbook "${topic}" — available: ${COOKBOOK_TOPICS.join(" | ")}`,
  }
}
