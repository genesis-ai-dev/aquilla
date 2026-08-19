// Onboarding playbooks (AQU-CMDREG-P1 §4) — L2 prose fetched with
// docs({topic}), never resident in the prompt. Each one sequences EXISTING
// registered commands and tools; this file adds no tool, no command, and no
// capability. Kept out of docs.ts so both files stay small.
//
// Every playbook restates the human gate, because it is the property that most
// often gets lost when a model chains many steps: the agent STAGES, a person
// reviews and applies. Nothing here writes anything on its own.

export const PROJECT_BOOTSTRAP = `# Playbook: project bootstrap — empty project to workable

Order matters. Each numbered step stages ONE changeset that the person reviews
and applies before the next step reads the state it produced.

1. Source content in. The person uploads the file (in-app, or the Agent API
   artifact endpoint); you never fabricate one. Then:
   propose_command({commands:[{kind:'PlanImport', fileName, fileType,
     artifactId, cells:[…]}]})
   Gotchas: PlanImport must be the SOLE command in its changeset; cap 5000
   cells; floor PROJECT_LEAD (500). Prefer parsing the uploaded artifact
   server-side and staging from its results, so the original round-trips on
   export. Duplicate file names are a staleness precondition — commit re-checks.

2. Languages and lanes.
   propose_command({commands:[{kind:'PatchSettings', projectId, ifMatchVersion,
     ops:[{key:'sourceLanguage', value:'…'}, {key:'targetLanguage', value:'…'},
          {key:'targetLanes', value:['es','pt']}]}]})
   Gotchas: PatchSettings is also sole-command; read the LIVE settings version
   first and pass it as ifMatchVersion (drift → plan_stale, re-read and stage
   again); one op per key (a duplicate key is validation_failed); floor
   MAINTAINER (600) for these keys. Register lanes BEFORE any lane-scoped
   SetTranslation — prepare rejects an unregistered laneId.

3. Termbase seed. Same command, key 'terminology':
   propose_command({commands:[{kind:'PatchSettings', projectId, ifMatchVersion,
     ops:[{key:'terminology', value:{concepts:[…]}}]}]})
   Gotcha: 'terminology' has its OWN floor — the org's termbaseEditMinRole
   (default PROJECT_LEAD 500), not 600. Seed from the source text and the
   person's decisions, never from general knowledge. See docs('terminology').

4. Translation brief. Key 'translationBrief' (audience, purpose, register,
   literalness, key-term strategy, constraints), staged the same way at
   MAINTAINER. Propose a DRAFT brief from what the project already shows and
   ask the person to correct it — do not invent standards. See docs('brief').

5. Route the work.
   propose_command({commands:[{kind:'EmitEvents', events:[{kind:
     'assignment.create', payload:{assignmentId:'<new-unique-id>', scopeKind,
     scope, scopeLabel, assigneeUserId, deadline?, note?}}]}]})
   Gotchas: EmitEvents is sole-command, max 200 events, and the floor is the
   max over inner kinds (assignment.create is PROJECT_LEAD 500). You can only
   assign EXISTING project members — INVITING someone is not a command; tell
   the person to do it in project settings. assignmentId must be new.

Done when readiness has no blocking gaps — verify, do not assume:
- a source file exists with cells: read({fileId}) returns rows
- targetLanes / sourceLanguage / targetLanguage are set
- terminology has concepts (or the person explicitly deferred it)
- translationBrief is non-null
- at least one active assignment covers the work
Report the gaps you could not close and who has to close them.

THE HUMAN GATE: every step above only STAGES a changeset. Nothing is written
until the person opens the review card and applies it. Stage one step, say what
it does, and wait — do not queue all five and describe the project as set up.`

export const QA_SWEEP = `# Playbook: QA sweep — one pass over drafted work

Goal: turn a file's drafted cells into either a clean waiver, a comment a human
can act on, or a validation queue. Read first, stage last.

1. Scope it. read({fileId|ref, filter:'drafted'}) — also filter:'flagged' for
   rule violations and filter:'stale' for cells whose source moved (AD-9).
   Page with offset rather than raising limit.

2. Chase the specific issue. search({q:'term or phrase', side:'target'}) to see
   every rendering in the project; examples({text}) for how validated cells
   handled the same source. Check existing waivers before re-flagging anything
   (docs('checking') has the cell_waivers query).

3. Stage the mechanical part — rule flags that are genuinely false positives:
   propose_command({commands:[{kind:'EmitEvents', events:[
     {kind:'cell.waive', fileId, cellId, payload:{ruleId, reason:'…'}}]}]})
   Gotchas: EmitEvents is sole-command, max 200 events; every referenced
   file/cell must exist at prepare and ONE bad reference rejects the whole plan
   (no silent skips); head pins are server-resolved — never supply
   editEventId/targetEventId/sourceEventId yourself, a supplied value is
   rejected; commit re-checks the pins (plan_stale on drift). Floor is the max
   over inner kinds (cell.waive is CONTRIBUTOR 400).

4. Stage the validation queue SEPARATELY:
   propose_command({commands:[{kind:'EmitEvents', events:[
     {kind:'cell.validate', fileId, cellId, payload:{}}]}]})
   cell.validate / cell.unvalidate are TESTIMONY tier: the review card makes
   the person confirm them ONE AT A TIME, never in bulk, and they are excluded
   from any bulk apply. So keep them in their own changeset — mixing waives and
   validations into one plan makes the person confirm the whole card item by
   item. Floor REVIEWER (300).

5. Judgment calls become comments, not edits:
   {kind:'comment.create', fileId, cellId, payload:{body:'…'}} (COMMENTER 200).
   Deterministic rule violations are already re-checked client-side — spend
   comments on things a rule cannot see.

Never stage a validation the person did not ask for or review. A validation is
a human endorsement you are recording on their behalf; it is not your opinion
of the text, and staging one to "clear" a queue is a correctness bug.

THE HUMAN GATE: waives, validations and comments are all STAGED. Nothing lands
until the person applies the changeset — and testimony items are confirmed
individually inside that card. Report what you staged and what still needs a
human decision.`

export const FIRST_CYCLE = `# Playbook: first cycle — the honest first run

Read this before drafting anything in a project that has no validated pairs,
no brief, and no termbase.

Drafting at zero readiness does NOT fail loudly. It produces fluent, generic,
plausible output — the expensive kind of wrong, because it reads well enough to
be applied and then has to be found and undone verse by verse. The whole point
of the first cycle is to make that visible on ONE passage instead of a book.

1. Pick ONE small passage the person names (a chapter, or ~10 cells).
   read({ref:'MRK 4', filter:'untranslated'})

2. Measure readiness before drafting, and say the numbers out loud:
   - examples({text}) — how many validated pairs come back? Zero means the
     project has no observed practice to imitate.
   - docs('brief') — is translationBrief null?
   - docs('terminology') — does the termbase have concepts?
   - is there a paired source file at all (docs('files-and-refs'))?

3. Draft that passage only: draft({ref:'MRK 4', limit:10}). The draft tool
   stages a proposal; it caps at 10 cells per call by design.

4. Show the person the draft AND the gaps together. Name which gap shaped which
   weakness ("no termbase, so 'covenant' is rendered three ways"; "no validated
   pairs, so the register is my guess"). Do not present a zero-readiness draft
   as a result.

5. Fill the gaps — each of these is a staged changeset the person applies:
   - termbase: PatchSettings op on 'terminology' (org termbase floor, default
     500)
   - brief: PatchSettings op on 'translationBrief' (MAINTAINER 600)
   - exemplars: there is no command for these. Ask the person to hand-translate
     and validate 5-10 cells. That is the highest-value thing they can do, and
     only they can do it.

6. Re-run draft on the SAME passage and show the difference. That difference is
   the argument for doing step 5 on the rest of the project — it is the reason
   this playbook drafts one passage twice instead of a book once.

THE HUMAN GATE: draft and propose_command both STAGE. Nothing is written until
the person applies, and applying is where the judgment lives — so a first cycle
that ends with "I staged 400 cells" has skipped the point. End it with one
passage, the gaps you found, and what you need from them next.`
