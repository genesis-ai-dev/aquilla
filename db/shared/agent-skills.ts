// Agent skills (AQU-1294 §2.3) — dependency-free, importable by BOTH workers.
//
// A skill is L2 prose that sequences EXISTING commands and routes so the
// sequencing lives in one place the server owns, not in each partner's chat
// history. Served identically from three surfaces: REST
// GET /api/v1/external/skills/:name, the MCP get_skill tool (indexed by
// get_capabilities.skills), and the in-app harness docs topic
// `skills/<name>` (auth-worker docs.ts). Adds no tool of its own beyond the
// lookup, no command, and no capability.
//
// Every skill restates THE HUMAN GATE: the agent STAGES, a person reviews and
// applies. Nothing here writes anything on its own.

export interface AgentSkill {
  /** URL-safe id: GET /skills/:name, get_skill { name }, docs topic skills/<name>. */
  name: string
  title: string
  oneLiner: string
  /** Markdown body. Starts with "# Skill:". */
  body: string
}

const PROJECT_SETUP = `# Skill: project-setup — stand up a partner project with ONE approval

Use this when an operator hands you a partner's filled intake form (or asks you
to set up a project for a partner). It sequences the intake template, the
ProjectSetup composite command, and the verification receipt so the whole
setup is one changeset and one human approval.

Precondition: ProjectSetup runs against an EXISTING project. If the project
does not exist yet, stage CreateProject first — it is its own changeset and its
own (always ask-mode) approval — and only then follow the steps below against
the new projectId.

1. Get the form. GET /api/v1/external/setup-template returns the intake
   Markdown (to email a partner) and the JSON schema of the body it produces.
   If the operator already has a FILLED form, send its Markdown back:
   POST /api/v1/external/setup-template/parse { markdown } → { setup,
   warnings, nextStep }. \`setup\` is the ProjectSetup body minus kind /
   projectId; \`warnings\` names every blank.

2. Never guess these four. If settings.sourceLanguage, settings.targetLanguage,
   brief.parameters.sourceTexts or brief.parameters.keyTerms is blank
   (warnings with required: true), STOP and return the blanks to the operator
   as questions for the partner. Do not stage anything. Everything else may be
   defaulted — but every defaulted value must be marked "(defaulted)" in the
   approval summary so the approver sees what the partner did not say.

3. Files. Upload each attached source file as an artifact
   (POST .../projects/:projectId/artifacts, header x-artifact-name) and run the
   parse PREVIEW (POST .../artifacts/:artifactId/parse, or the preview_import
   tool). REFUSE to stage any import whose preview cells contain a backslash
   (\`\\\`) — a USFM marker leaking into cell text is a parser problem: report
   it as one, with the artifactId and a sample cell, and never hand-clean the
   file. Fill setup.imports from the previews that pass (artifactId, fileName
   from the form's file-format/books lines, fileType from the preview). Do NOT
   turn on importExcludeFrontMatter for partner USFM: skipping the book intro
   leaves it untranslated.

4. Stage ONE ProjectSetup. POST .../projects/:projectId/changesets with
   { commands: [{ kind: "ProjectSetup", projectId, settings, brief, members,
   imports }] }. The server owns the step order and the version guards, so
   plan_stale cannot occur inside the plan. Return the SINGLE approvalUrl to
   the operator. A prepare rejection names the offending field (duplicate file
   name, loosening policy write, unknown brief section) — fix the input and
   re-prepare; do not split the plan into separate changesets.

5. After commit, report the verification receipt (receipt.verification):
   settingsVersion, members with their live roles, files with cellCount and
   cellsWithMarkup, briefReachesCopilot, briefDetails, policyKeysNotApplied. If
   briefReachesCopilot is false, SAY SO — the brief is not reaching the
   copilot and the operator has to act on it: quote briefDetails.reason and
   stage a RegenerateBriefSummary changeset. briefReachesCopilot is a
   freshness claim: it is true only when the L1 summary was re-rendered inside
   this commit, so a true means the sections you just wrote are what the AI
   reads. Report briefDetails.truncated when it is set — the summary was
   clipped at 1600 characters and some committed sections are missing from it,
   even though the rest reached the copilot. If cellsWithMarkup is non-zero,
   report it as a parser problem, as in step 3.

THE HUMAN GATE: this skill STAGES one changeset. Nothing is written until a
person opens the approvalUrl, reviews the server-computed summary, and applies
it; a mid-plan failure leaves a receipt with completedSteps and failedStep, and
COMMITTING THE SAME CHANGESET AGAIN resumes at the failed step (steps already
applied are skipped, and the human approval is not consumed a second time).
Re-commit the same changeset id; stage a fresh plan only when the INPUT was
wrong. Stage it, say what it does, and wait.`

export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    name: 'project-setup',
    title: 'Partner project setup — one plan, one approval',
    oneLiner:
      'Intake form → ProjectSetup composite command → verification receipt, with the four never-guess fields and the markup refusal.',
    body: PROJECT_SETUP,
  },
]

export function getSkill(name: string): AgentSkill | null {
  return AGENT_SKILLS.find((s) => s.name === name) ?? null
}
