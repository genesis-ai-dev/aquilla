# Aquilla Agent API — ProjectSetup: one plan, one approval

**Status:** proposal · **Author:** Joel Maves · **Date:** 2026-09-16
**Evidence:** IBT `sibtatar` setup, 2026-09-16 — 8 approval links, 6 sequenced changesets, 1 client-side workaround, 2 manual UI steps, ~4 hours wall-clock for a 1-file project.

## 1. Problem

Setting up one partner project through the Agent API today takes:

| Step | Changeset | Why it had to be separate |
|---|---|---|
| CreateProject | sole, always ask-mode | project must exist before anything else |
| PatchSettings (languages, flags) | sole, `ifMatchVersion: 0` | version guard |
| SetBrief | sole, `ifMatchVersion: 1` | must wait for settings to commit |
| InviteMember ×3 | membership batch | cannot mix with other kinds |
| RenameFile (bad import) | sole | duplicate-name precondition on the next import |
| PlanImport | sole | after settings so flags apply |
| file.delete (EmitEvents) | sole | cleanup |

Each one is a URL for a human to open, in an order only the agent knows. If the human opens them out of order, `plan_stale` and `duplicate_file` fire. Nothing in the API tells a fresh agent this order; I learned it by hitting the errors.

Two steps could not be done by the agent at all: regenerating the brief summary (in-app only), and setting `contributeToGlobalTm: false` / `agentAuthorship: "none"` (policy keys, refused) — see AQU-1282.

Half the inputs (base text, dialect, key terms, the file itself) come from the partner's translator or exegete, not from the Frontier operator, over several emails.

## 2. Proposal

Three pieces. They ship in this order.

### 2.1 `ProjectSetup` composite command (server)

One command, one changeset, one approval, one commit. The server expands it into the ordered internal steps and chains the version guards itself.

```jsonc
{
  "kind": "ProjectSetup",
  "project": { "id": "sibtatar", "name": "Siberian Tatar (SIbtatar) — IBT pilot", "orgId": "46441" },
  "settings": {                       // any PatchSettings key; policy keys allowed in restrictive direction only (AQU-1282)
    "sourceLanguage": "ru",
    "targetLanguage": "sty",
    "importExcludeFrontMatter": true,
    "bibleResourcesEnabled": true,
    "contributeToGlobalTm": false,
    "agentAuthorship": "none"
  },
  "brief": { "parameters": { "purpose": "…", "audience": "…", /* SetBrief sections */ }, "freeformNotes": "…" },
  "members": [ { "username": "gulsifa", "role": 600 }, { "username": "terciman", "role": 600 } ],
  "imports": [ { "artifactId": "01a0aa7f-…", "fileName": "Acts", "fileType": "usfm" } ]
}
```

`project` is optional — omit it to run setup against an existing project (the common case for "add a second book" or "fix the brief").

**Server-side expansion, in this fixed order:**

1. `CreateProject` (if `project` present) — always ask-mode, as today.
2. `PatchSettings` with every non-policy key, `ifMatchVersion` read by the server at commit time, not supplied by the agent.
3. `PatchSettings` policy keys, restrictive direction only (AQU-1282). Refuse the whole plan at *prepare* if any policy write loosens.
4. `SetBrief` + summary render (AQU-1282's `RegenerateBriefSummary`, or auto-render on SetBrief commit).
5. Membership batch.
6. For each import, in array order: parse → check `fileName` uniqueness → PlanImport. Reject at prepare if two imports share a name or a name already exists in the project.
7. Verification receipt (see 2.4).

**Approval page** lists every step in plain language, one page, one Approve button. This is what AQU-841 already does for per-changeset approvals; ProjectSetup just makes one changeset out of what used to be six.

**Failure semantics:** stop at the first failing step, commit nothing after it, return a receipt with `completedSteps[]` and `failedStep`. Steps already applied stay applied (a created project, added members) because rolling those back is more dangerous than leaving them. Re-preparing the same plan skips steps whose end-state already exists (`superseded`) and resumes at the failed one — so "fix the input and re-run" is the recovery path, not "clean up by hand."

**Floors:** max of the constituent floors (OWNER on org for CreateProject, else MAINTAINER 600).

**Limits:** `imports` ≤ 10 per plan, each ≤ `planImportMaxCells`. Members ≤ 25 (existing batch cap).

### 2.2 Partner intake template (server-served)

`GET /api/v1/external/setup-template` returns the intake form as Markdown (for email) and as JSON schema (for agents), so every partner, on every console, fills the same form. `POST /api/v1/external/setup-template/parse` takes the filled Markdown back and returns a `ProjectSetup` body with a `warnings[]` list of blanks.

Fields (see `partner-intake.md` for the human version):

- Project: language name, ISO 639-3 code, script, org
- Team: username + role per person (translator / exegete / coordinator / reviewer)
- Source: base text name, version, who owns the copyright, file format, files attached
- Brief: the 11 SetBrief sections as plain questions, in partner language
- Constraints: region restrictions (VPN / no VPN), privacy needs (authorship hidden yes/no), TM sharing yes/no
- Anything the AI must never do

### 2.3 `project-setup` skill (agent harness, in repo)

A skill in `sync-worker`'s agent skill set (the one `describe_command` reads from), served to any agent via `get_capabilities.skills`. It says:

1. Call `GET /setup-template`; if the operator has a filled form, `POST /setup-template/parse`.
2. If the form has blanks in `sourceLanguage`, `targetLanguage`, `sourceTexts`, or `keyTerms`, **stop and return the blanks as questions for the partner** — do not guess these four. Everything else may be defaulted with a `(defaulted)` marker in the approval summary.
3. Upload artifacts. Run parse preview. **Refuse to stage any import whose preview `sampleCells` contain `\`** — report it as a parser problem, never hand-clean the file. (Until AQU-1283 ships, this check will fire on every USFM with footnotes; that is the point.)
4. Stage one `ProjectSetup`. Return the single approval URL.
5. After commit, run the verification receipt (2.4) and report it. If `prompt-preview.parts.brief` is empty, say so — that is the brief not reaching the copilot.

The skill is ~60 lines. It exists so the sequencing lives in one place the server owns, not in each partner's chat history.

### 2.4 Verification receipt

Appended to the `ProjectSetup` commit receipt, computed server-side:

```jsonc
{
  "settingsVersion": 2,
  "members": [{ "username": "gulsifa", "role": 600 }, …],
  "files": [{ "fileId": "…", "name": "Acts", "cellCount": 1089, "cellsWithMarkup": 0 }],
  "briefReachesCopilot": true,          // prompt-preview parts.brief non-empty on first verse cell
  "policyKeysNotApplied": ["validationRoleFloor"]  // anything the plan asked for that the server refused
}
```

This is what the operator reads instead of re-querying five endpoints.

## 3. What this does NOT do

- Does not approve anything itself. One approval, still by a human, still in the browser. The point is *one*, not *zero*.
- Does not loosen policy keys. AQU-1282's restrictive-direction rule applies inside the plan.
- Does not fix the USFM parser. AQU-1283 must ship first or step 3 of the skill refuses every real file.
- Does not delete files. Cleanup stays a separate, explicit `file.delete`.

## 4. Ordering of work

1. AQU-1283 (parser bugs) — already filed, hotfix.
2. AQU-1282 (policy direction + brief summary) — already filed.
3. This: `ProjectSetup` + verification receipt.
4. Setup template + parse endpoint.
5. Skill in the harness, and update `get_capabilities.quickstart` to point new agents at it.

## 5. Acceptance criteria

- [ ] A fresh agent given only the API map and a filled intake form can stand up a project (settings, brief that reaches the copilot, members, one USFM import) with exactly **one** human approval and zero in-app steps
- [ ] Out-of-order submission is impossible: the server owns the order; `plan_stale` cannot occur inside a plan
- [ ] A plan with a duplicate file name, a loosening policy write, or an unknown brief section is rejected at prepare with the offending field named
- [ ] Re-running a plan after a mid-plan failure resumes at the failed step and skips completed ones
- [ ] Verification receipt reports `cellsWithMarkup` and `briefReachesCopilot`; both are asserted in worker tests using the NRT Acts artifact from `sibtatar`
- [ ] `GET /setup-template` returns Markdown and JSON schema; `POST /setup-template/parse` round-trips the `partner-intake.md` example to the `ProjectSetup` body above
- [ ] `describe_command ProjectSetup` documents expansion order, failure semantics, and the four never-guess fields
