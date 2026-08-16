import { defineNamespace, plural } from "./types"

/**
 * Translation-agent surfaces: workbench, working set, memory/brief, proposals
 * and the changeset approval gate.
 *
 * Registered ahead of its strings so the six parallel keying agents never
 * contend on `messages/en.ts` / `namespaces/index.ts` — see
 * `docs/swarm/I18N-COVERAGE-ORCHESTRATION.md`. A registered-but-empty namespace
 * is invisible to `CATALOG_CONTEXT` (its name is derived from its first key's
 * prefix), so this compiles and lints clean while empty.
 *
 * Declares no screenshot surface of its own: the workbench and the approval
 * gate render over the `editor-table` surface that `editor` declares.
 *
 * Wording discipline: the agent never applies a write on its own — every
 * agent-authored change lands as a PROPOSAL (a staged changeset, a staged
 * cell draft, a staged memory/brief edit) that sits behind a human
 * approve/reject click. Every key here that names that state keeps the verb
 * unambiguous: "staged"/"proposed"/"prepared" for the pending state,
 * "approved"/"accepted"/"applied"/"committed" only once a human has acted.
 * Never soften that line in translation — a locale that blurs "proposed" and
 * "applied" hides the approval gate from the very person it protects.
 */
export const agent = defineNamespace({
  keys: {
    // ── Dock panel + dock chat view (AgentDockPanel, AgentDockView) ────────
    "agent.dock.title": "AI Agent",
    "agent.dock.openInEditorTooltip": "Open in editor tab",
    "agent.dock.openInEditorAriaLabel": "Open agent in editor tab",
    "agent.dock.openInEditorNotice": "The agent is open in an editor tab.",
    "agent.dock.signInNotice": "Sign in to use the agent.",
    "agent.dock.composerPlaceholder": "Ask the agent… (/draft, /check, /find, /status)",
    "agent.dock.attachFileAriaLabel": "Attach file",
    "agent.dock.attachFileTitle": "Attach a file for the agent",

    // ── Rename-suggestions banner (SuggestionBanner) — unrelated feature
    //    (Bible-book / episode file naming), keyed here because this agent
    //    owns the file. ──────────────────────────────────────────────────
    "agent.rename.bannerSuffix": "— apply friendly names?",
    "agent.rename.review": "Review",
    "agent.rename.applyAll": "Apply all",

    // ── First-run empty state (AgentEmptyState) ─────────────────────────
    "agent.emptyState.dismissedNotice":
      "Ask the agent to draft, check, or explain — it proposes changes you review and apply.",
    "agent.emptyState.userGuideLink": "User guide",
    "agent.emptyState.intro":
      "The agent works inside this project — it can search, draft, and check. Every change arrives as a proposal {you} review and apply.",
    "agent.emptyState.introYou": "you",
    "agent.emptyState.tryAsking": "Try asking",
    "agent.emptyState.shortcuts": "Shortcuts",
    "agent.emptyState.dismiss": "Don't show this again",

    // ── Run timeline (AgentRunView) ─────────────────────────────────────
    "agent.run.stepRunning": "Step running",
    "agent.run.stepSucceeded": "Step succeeded",
    "agent.run.stepFailed": "Step failed",
    "agent.run.capped": "Run hit its step/token cap — results may be partial.",
    "agent.run.tokenUsage": "{promptTokens} prompt + {completionTokens} completion tokens",

    // ── Full-screen workbench (AgentWorkbench) ──────────────────────────
    "agent.workbench.newSessionAriaLabel": "New session",
    "agent.workbench.minimizeTooltip": "Minimize to sidebar",
    "agent.workbench.closeAriaLabel": "Close workbench",
    "agent.workbench.tabsAriaLabel": "Agent workbench sections",
    "agent.workbench.sessionsTab": "Sessions",
    "agent.workbench.loadingMemory": "Loading memory…",
    "agent.workbench.queuedCount": plural({ one: "{count} queued", other: "{count} queued" }),

    // ── Bible Aquifer publish proposal (AquiferProposalCard) ────────────
    "agent.aquifer.discarded": "Discarded: {question}",
    "agent.aquifer.publishFailed": "Publish failed",
    "agent.aquifer.published": "Published",
    "agent.aquifer.publishing": "Publishing…",

    // ── Run cost-cap meter (BudgetMeter) ────────────────────────────────
    "agent.budget.exhausted": "Run stopped at its {capCredits} credit cap ({spentCredits} spent).",

    // ── Staged changeset review (ChangesetCard, ChangeList, and the
    //    full-page /approve/:changesetId gate in ApproveChangeset) ──────
    "agent.approve": "Approve",
    "agent.reject": "Reject",
    "agent.accept": "Accept",
    "agent.changeset.approvedNotice": "Approved — the agent can now commit these changes.",
    "agent.changeset.viewFullDetails": "View full details",
    "agent.changeset.moreChanges": plural({
      one: "…and {count} more change.",
      other: "…and {count} more changes.",
    }),
    "agent.changeset.moreCellsPreview": "…and {count} more cells.",
    "agent.changeset.approveAgentChanges": "Approve agent changes",
    "agent.changeset.signInNotice": "Sign in to review and approve this changeset.",
    "agent.changeset.approvedFull": "Approved — return to your agent, it can now commit.",
    "agent.changeset.rejectedFull": "Rejected — the changeset was discarded.",
    "agent.changeset.loading": "Loading changeset…",
    "agent.changeset.backTo": "Back to {projectName}",
    "agent.changeset.notStagedNotice":
      "This changeset is currently {status} and can no longer be approved.",
    "agent.changeset.whatWillBeApplied": "What will be applied",
    "agent.changeset.noChangesSummarized": "No changes summarized.",
    "agent.changeset.settingsChanges": "Settings changes",
    "agent.changeset.changesHeading": "Changes ({count})",
    "agent.changeset.warnings": "Warnings",
    "agent.changeset.digestLabel": "Digest:",

    // ── Sandboxed code activity (CodeActivityBlock) ─────────────────────
    "agent.code.runningAriaLabel": "Code running",
    "agent.code.noOutput": "(no output)",
    "agent.code.outputTruncated": "Output truncated — the sandbox caps stdout/stderr at 64KB each.",
    "agent.code.runningEllipsis": "Running…",

    // ── Memory + brief: chat notices (MemoryProposalNotice), the Memory
    //    tab shell (AgentMemoryTab), the approved list (ApprovedMemoryList),
    //    the project brief panel (BriefPanel), and the proposed queue
    //    (ProposedMemoryList). ──────────────────────────────────────────
    "agent.memory.reviewInMemoryTab": "Review in Memory tab",
    "agent.memory.reviewed": "Reviewed",
    "agent.memory.proposedNotice": "Proposed memory {path} — {preview}",
    "agent.memory.briefProposedNotice": "Proposed brief update — {preview}",
    "agent.memory.signInNotice": "Sign in to view agent memory.",
    "agent.memory.loading": "Loading agent memory…",
    "agent.memory.tabProposed": "Proposed",
    "agent.memory.tabApproved": "Approved",
    "agent.memory.projectBriefTitle": "Project brief",
    "agent.memory.supersedeTitle": "Replace the human-edited memory?",
    "agent.memory.supersedeBody":
      "Approving will replace the human-edited memory at {path}. The existing human-authored content will be archived.",
    "agent.memory.supersedeConfirm": "Replace it",
    "agent.memory.noneApproved": "No approved memories yet.",
    "agent.memory.protectedTooltip": "Protected: the agent cannot modify this; it can only ask.",
    "agent.memory.humanEditedBadge": "Human-edited",
    "agent.memory.contentAriaLabel": "Memory content",
    "agent.memory.loadingBrief": "Loading project brief…",
    "agent.memory.leadOnly": "Project lead only",
    "agent.memory.noBriefYet": "No brief written yet.",
    "agent.memory.proposalsHeading": "Brief proposals — high-oversight: human approval only.",
    "agent.memory.noPendingProposals": "No pending brief proposals.",
    "agent.memory.rationaleLabel": "Rationale:",
    "agent.memory.staleNotice": "Stale — brief changed since this was proposed",
    "agent.memory.requiresLeadNotice": "Requires project lead or higher to review",
    "agent.memory.editBriefTitle": "Edit project brief",
    "agent.memory.editMemoryTitle": "Edit {path}",
    "agent.memory.briefContentAriaLabel": "Brief content",
    "agent.memory.reloadLatestBrief": "Reload latest brief",
    "agent.memory.overwriteTitle": "Overwrite the project brief?",
    "agent.memory.overwriteBody":
      "This replaces the brief every agent run reads as ground truth. Continue?",
    "agent.memory.overwriteConfirm": "Overwrite",
    "agent.memory.noneProposed": "No proposed memories awaiting review.",
    "agent.memory.provenanceRun": "run {runId}",
    "agent.memory.provenanceSession": "session {sessionId}",
    "agent.memory.rejectConfirmTitle": "Reject this memory?",
    "agent.memory.rejectConfirmBody": "{path} will be marked rejected and dropped from the queue.",

    // ── Workbench receipt (ProposalReceipt) ─────────────────────────────
    "agent.receipt.draftsStaged": plural({
      one: "{count} draft staged",
      other: "{count} drafts staged",
    }),
    "agent.receipt.accepted": plural({ one: "{count} accepted", other: "{count} accepted" }),
    "agent.receipt.editedAccepted": plural({
      one: "{count} edited & accepted",
      other: "{count} edited & accepted",
    }),
    "agent.receipt.rejected": plural({ one: "{count} rejected", other: "{count} rejected" }),
    "agent.receipt.undone": plural({ one: "{count} undone", other: "{count} undone" }),
    "agent.receipt.toReview": plural({ one: "{count} to review", other: "{count} to review" }),
    "agent.receipt.checks": plural({ one: "{count} check", other: "{count} checks" }),
    "agent.receipt.reviewInWorkingSet": "Review in working set",
    "agent.receipt.undoTooltip":
      "Restore each applied cell to its pre-draft text (a new, audited edit — nothing is deleted)",
    "agent.receipt.undoApplied": "Undo applied",

    // ── Review editor (WorkingSetPanel) ──────────────────────────────────
    "agent.workingSet.emptyState":
      "The cells the agent reads and drafts appear here — source on the left, translation on the right, with staged drafts to accept or reject.",
    "agent.workingSet.title": "Working set",
    "agent.workingSet.acceptAllTooltip": "Accept every pending draft, with your edits (Shift+A)",
    "agent.workingSet.acceptRemaining": "Accept remaining ({count})",
    "agent.workingSet.keyboardHelp":
      "j/k move · Enter accept & next · type to edit · x reject · Shift+A accept remaining",
    "agent.workingSet.openInEditorTooltip": "Open in editor",
    "agent.workingSet.openLink": "open",
    "agent.workingSet.editTooltip": "Edit this draft (or just start typing)",
    "agent.workingSet.editingHelp": "Enter accept & next · Esc revert to draft · Shift+Enter newline",
    "agent.workingSet.draftDiscarded": "draft discarded — cell left untranslated",

    // ── Inline passage view (PassageCard) ────────────────────────────────
    "agent.passage.loadingChapterAriaLabel": "Loading chapter",
    "agent.passage.moreShowAll": "{count} more — show all",

    // ── Validation queue (ValidationQueueCard) ───────────────────────────
    "agent.validation.preparedCount": plural({
      one: "{count} validation prepared",
      other: "{count} validations prepared",
    }),
    "agent.validation.confirmedCount": "{done}/{total} confirmed",
    "agent.validation.testimonyNotice":
      "Validation is your testimony — confirm each line yourself. There is no confirm-all.",

    // ── Translation-brief interview + summary card (BriefBuilder,
    //    BriefSection) ───────────────────────────────────────────────────
    "agent.brief.helpMeWrite": "Help me write this",
    "agent.brief.notesPrompt": "Anything else the AI should know?",
    "agent.brief.saveDraft": "Save draft",
    "agent.brief.saveAndGenerate": "Save & generate summary",
    "agent.brief.pasteToPrefill": "Optional: paste an existing brief to pre-fill",
    "agent.brief.pastePlaceholder": "Paste notes or an existing brief…",
    "agent.brief.prefillFromText": "Pre-fill from text",
    "agent.brief.summaryOutOfDate": "Summary out of date",
    "agent.brief.capturePurpose":
      "Capture this project's purpose, audience, and standards so the AI drafts to your brief.",
    "agent.brief.createBrief": "Create brief",
    "agent.brief.noSummaryYet": "No summary generated yet.",
    "agent.brief.editBrief": "Edit brief",
  },
  context: {
    _context: {
      description:
        "The in-app translation agent: its workbench panel, the working set of files " +
        "it may touch, its memory/brief editor, the proposal receipts it returns, and " +
        "the changeset approval screen where a human accepts or rejects the agent's " +
        "staged writes. Nothing here is applied without that human approval, so the " +
        "wording must keep the distinction between a PROPOSED change and an APPLIED " +
        "one unmistakable in translation.",
      screenshot: "editor-table",
    },
    keys: {
      "agent.dock.openInEditorAriaLabel": {
        description:
          "Accessible name (and tooltip) for the icon button that opens the agent's " +
          "current session as a full editor tab (the workbench), from the compact dock " +
          "panel header.",
      },
      "agent.dock.composerPlaceholder": {
        description:
          "Placeholder text in the agent chat composer. The four bracketed tokens " +
          "(/draft, /check, /find, /status) are literal slash-command names the user " +
          "can type — keep them in Latin script, untranslated, exactly as shown; only " +
          "translate the surrounding words.",
      },
      "agent.dock.attachFileAriaLabel": {
        description:
          "Accessible name for the paperclip icon button that opens a file picker to " +
          "attach a file to the next agent prompt.",
      },
      "agent.dock.attachFileTitle": {
        description:
          "Native `title` attribute (browser tooltip) on the same attach-file button as " +
          "agent.dock.attachFileAriaLabel — a fuller sentence than the aria-label, shown " +
          "on hover only.",
      },
      "agent.rename.bannerSuffix": {
        description:
          "Trailing clause appended after a locally-built, already-pluralized count " +
          "phrase ('3 Bible books, 2 episodes') in the file-rename-suggestion banner, " +
          "forming one sentence: '<counts> — apply friendly names?'. Translate this " +
          "fragment as a question continuing that sentence; the counts phrase itself is " +
          "assembled in code and is not part of this key.",
      },
      "agent.emptyState.userGuideLink": {
        description:
          "Link text to the agent's help-center article, shown both in the collapsed " +
          "(dismissed) empty state and the full first-run guide.",
      },
      "agent.emptyState.intro": {
        description:
          "Opening sentence of the agent's first-run guide, explaining that every " +
          "change is a proposal the human reviews. The {you} placeholder is the word " +
          "'you', rendered in bold for emphasis — see agent.emptyState.introYou, which " +
          "supplies its translated text; position {you} wherever the sentence's second " +
          "person reference naturally falls in the target language.",
        placeholders: {
          you: "Renders agent.emptyState.introYou (the translated word for 'you') in bold. Not user data — a translatable pronoun kept as its own key so it can be styled separately.",
        },
      },
      "agent.emptyState.introYou": {
        description:
          "The emphasized second-person pronoun inside agent.emptyState.intro ('a " +
          "proposal YOU review and apply') — rendered in a bold span. Translate as the " +
          "pronoun that sentence needs in context, matching whatever form/register the " +
          "rest of the sentence uses.",
      },
      "agent.emptyState.dismiss": {
        description:
          "Button that permanently hides the first-run guide for this browser " +
          "(localStorage). Also the accessible name of that button.",
      },
      "agent.run.stepRunning": {
        description:
          "Accessible name for the spinner shown beside an in-progress tool-call chip " +
          "in the run timeline (e.g. a SQL query or draft step still executing).",
      },
      "agent.run.stepSucceeded": {
        description:
          "Accessible name for the checkmark icon beside a tool-call chip that " +
          "completed without error.",
      },
      "agent.run.stepFailed": {
        description:
          "Accessible name for the X icon beside a tool-call chip that errored.",
      },
      "agent.run.tokenUsage": {
        description:
          "Per-run usage line under the timeline, reporting prompt and completion token " +
          "counts. Both values are already locale-formatted numbers (thousands " +
          "separators applied) by the time they reach this string — keep both as plain " +
          "numeric text, and keep 'prompt' / 'completion tokens' as the two token " +
          "categories LLM billing conventionally distinguishes.",
        placeholders: {
          promptTokens: "Already locale-formatted count of prompt (input) tokens.",
          completionTokens: "Already locale-formatted count of completion (output) tokens.",
        },
      },
      "agent.workbench.newSessionAriaLabel": {
        description:
          "Tooltip and accessible name for the icon button that resets the workbench to " +
          "a fresh agent session, discarding the current conversation view (past runs " +
          "stay in history).",
      },
      "agent.workbench.closeAriaLabel": {
        description:
          "Accessible name for the icon button that minimizes the full-screen workbench " +
          "back to the sidebar dock panel. Its tooltip (agent.workbench.minimizeTooltip) " +
          "uses different wording ('Minimize to sidebar') for the same action — keep " +
          "both, translated independently; they do not need to match verbatim.",
      },
      "agent.workbench.tabsAriaLabel": {
        description:
          "Accessible landmark name (aria-label) for the tab list switching between the " +
          "workbench's Sessions and Memory tabs. Not visible text.",
      },
      "agent.workbench.queuedCount": {
        description:
          "Small counter beside the run header showing how many prompts are queued " +
          "behind the currently streaming run, waiting to send in order.",
        placeholders: { count: "Number of queued prompts." },
      },
      "agent.aquifer.discarded": {
        description:
          "Replaces a Bible Aquifer publish-proposal card once the reviewer discards " +
          "it, naming the question that was proposed for publication.",
        placeholders: { question: "The Aquifer question text the proposal would have answered." },
      },
      "agent.budget.exhausted": {
        description:
          "Alert shown once an agent run is stopped because it hit its org credit cap. " +
          "Both values are already-formatted credit amounts including their unit " +
          "('500 cr') — do not add a second currency/unit word around them.",
        placeholders: {
          capCredits: "The run's credit cap, already formatted with its unit (e.g. '500 cr').",
          spentCredits: "Credits spent when the run stopped, already formatted with its unit.",
        },
      },
      "agent.changeset.moreChanges": {
        description:
          "Truncation notice under a sampled list of per-cell changes in a staged " +
          "changeset, stating how many further changes exist beyond the ones shown.",
        placeholders: { count: "How many additional changes are not shown; also selects the plural form." },
      },
      "agent.changeset.moreCellsPreview": {
        description:
          "Truncation notice under a sampled list of cells in a changeset's import " +
          "preview, stating how many further cells the import will create beyond the " +
          "sample shown. Always uses the plural noun in English regardless of the " +
          "count — match that convention rather than adding singular/plural agreement, " +
          "so the rendered English text does not change.",
        placeholders: { count: "How many additional cells are not shown in the sample." },
      },
      "agent.changeset.backTo": {
        description:
          "Link back to the project a changeset belongs to, shown after an approve or " +
          "reject action on the /approve/:changesetId page.",
        placeholders: { projectName: "The project's display name, or the literal word 'project' when no name is known." },
      },
      "agent.changeset.notStagedNotice": {
        description:
          "Notice on the approval page when a changeset is no longer in a state that " +
          "can be approved (it was already committed, discarded, or expired).",
        placeholders: {
          status: "Raw server status word (e.g. 'committed', 'discarded', 'stale', 'expired') — not translated, shown verbatim.",
        },
      },
      "agent.changeset.changesHeading": {
        description:
          "Heading over the sampled per-cell change list on the approval page, with " +
          "the total change count in parentheses.",
        placeholders: { count: "Total number of changes in the changeset (may exceed how many are listed below it)." },
      },
      "agent.code.runningAriaLabel": {
        description:
          "Accessible name for the spinner shown while a sandboxed code-execution step " +
          "is still running, before it has settled with a duration.",
      },
      "agent.memory.proposedNotice": {
        description:
          "Inline read-only chat notice for an agent-proposed memory entry, naming the " +
          "memory's file path and a short preview of its content. The {path} placeholder " +
          "renders in a monospaced span.",
        placeholders: {
          path: "The proposed memory's file path (e.g. 'observations/mrk.md'), rendered monospaced.",
          preview: "A short preview of the proposed memory's content.",
        },
      },
      "agent.memory.briefProposedNotice": {
        description:
          "Inline read-only chat notice for an agent-proposed project-brief update, " +
          "with a short preview of the proposed change.",
        placeholders: { preview: "A short preview of the proposed brief update's content." },
      },
      "agent.memory.supersedeBody": {
        description:
          "Body of the confirmation dialog shown when approving a memory would replace " +
          "one a human already edited by hand. The {path} placeholder renders in a " +
          "monospaced span.",
        placeholders: { path: "File path of the human-edited memory that would be replaced, rendered monospaced." },
      },
      "agent.memory.contentAriaLabel": {
        description: "Accessible name for the textarea editing an approved memory's raw content.",
      },
      "agent.memory.editMemoryTitle": {
        description:
          "Title of the dialog for editing one approved agent memory, naming the memory " +
          "by its file path. The English was previously glued together in JSX as the word " +
          "'Edit' followed by the path expression, which puts the verb before the object " +
          "in every locale; it is one string with a placeholder so the path can move.",
        placeholders: {
          path: "File path of the memory being edited, e.g. 'glossary/terms.md'. A literal path — never translate the substituted value.",
        },
      },
      "agent.memory.briefContentAriaLabel": {
        description: "Accessible name for the textarea editing the project brief's raw content.",
      },
      "agent.memory.provenanceRun": {
        description:
          "Small badge on a proposed-memory card naming the agent run that produced " +
          "it — a short technical label, not a full sentence.",
        placeholders: { runId: "The run's id, shown verbatim (not translated)." },
      },
      "agent.memory.provenanceSession": {
        description:
          "Small badge on a proposed-memory card naming the agent session that " +
          "produced it — a short technical label, not a full sentence.",
        placeholders: { sessionId: "The session's id, shown verbatim (not translated)." },
      },
      "agent.memory.rejectConfirmBody": {
        description:
          "Body of the confirmation dialog before rejecting a proposed memory, naming " +
          "the memory's file path (rendered in a monospaced element) and stating the " +
          "consequence.",
        placeholders: { path: "The proposed memory's file path, rendered monospaced." },
      },
      "agent.receipt.draftsStaged": {
        description:
          "Headline of the workbench's compact receipt for a staged proposal, stating " +
          "how many drafts it staged.",
        placeholders: { count: "Number of drafted cell events in the proposal." },
      },
      "agent.receipt.accepted": {
        description:
          "Live counter badge on a proposal receipt: how many of its drafts have been " +
          "accepted as-is (no edits) so far.",
        placeholders: { count: "Number of drafts accepted unedited." },
      },
      "agent.receipt.editedAccepted": {
        description:
          "Live counter badge on a proposal receipt: how many of its drafts were " +
          "edited by the reviewer before being accepted.",
        placeholders: { count: "Number of drafts edited and then accepted." },
      },
      "agent.receipt.rejected": {
        description: "Live counter badge on a proposal receipt: how many drafts were rejected.",
        placeholders: { count: "Number of drafts rejected." },
      },
      "agent.receipt.undone": {
        description:
          "Live counter badge on a proposal receipt: how many previously-applied " +
          "drafts have since been undone (compensated back to their pre-run value).",
        placeholders: { count: "Number of drafts undone." },
      },
      "agent.receipt.toReview": {
        description:
          "Live counter badge on a proposal receipt: how many of its drafts are still " +
          "undecided, waiting for the reviewer.",
        placeholders: { count: "Number of drafts still awaiting a decision." },
      },
      "agent.receipt.checks": {
        description:
          "Live counter badge on a proposal receipt: how many rule-lint findings exist " +
          "across its still-undecided drafts.",
        placeholders: { count: "Number of rule-lint findings on undecided drafts." },
      },
      "agent.workingSet.title": {
        description:
          "Heading of the workbench's review grid (the 'working set' of cells the " +
          "agent is touching), and also the accessible landmark name (aria-label) of " +
          "its container — the same word serves both roles.",
      },
      "agent.workingSet.acceptRemaining": {
        description:
          "Button that accepts every still-pending draft in the working set at once, " +
          "with the count of drafts it will accept.",
        placeholders: { count: "Number of pending drafts the button will accept." },
      },
      "agent.workingSet.keyboardHelp": {
        description:
          "Footer hint listing the working-set grid's keyboard shortcuts. 'j/k', " +
          "'Enter', 'x', and 'Shift+A' are literal key names — keep them untranslated, " +
          "in Latin script; translate only the words describing what each key does.",
      },
      "agent.workingSet.editingHelp": {
        description:
          "Footer hint shown while editing a single draft cell in place. 'Enter', " +
          "'Esc', and 'Shift+Enter' are literal key names — keep them untranslated, in " +
          "Latin script; translate only the words describing what each key does.",
      },
      "agent.passage.loadingChapterAriaLabel": {
        description:
          "Accessible name for the spinner shown while an inline passage card is " +
          "fetching the next/previous chapter — distinct from a generic 'Loading' so a " +
          "screen-reader user knows specifically what is loading.",
      },
      "agent.passage.moreShowAll": {
        description:
          "Link at the bottom of a long inline passage card that reveals the rest of " +
          "its rows, stating how many more rows are hidden. Preceded in the UI by a " +
          "literal ellipsis character that is not part of this key.",
        placeholders: { count: "Number of additional rows hidden below the cap." },
      },
      "agent.validation.preparedCount": {
        description:
          "Headline of a validation-queue card, stating how many cell.validate events " +
          "the agent staged for the human's individual confirmation.",
        placeholders: { count: "Number of validate events staged." },
      },
      "agent.validation.confirmedCount": {
        description:
          "Progress counter on a validation-queue card: how many of the staged " +
          "validations the human has confirmed so far, out of the total.",
        placeholders: {
          done: "How many validations have been confirmed so far.",
          total: "Total number of validations staged in this queue.",
        },
      },
    },
  },
  surfaces: [],
})
