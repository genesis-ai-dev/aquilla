import { defineNamespace, plural } from "./types"

/**
 * `terminology` namespace — termbase / glossary / translation-memory chrome
 * (AQU-832, WS-16).
 *
 * Every key here MUST stay prefixed `terminology.` — the namespace's name is
 * derived from its first key, not from the filename.
 *
 * The chrome/content line (see docs/swarm/ORCHESTRATION.md for the area brief):
 * NEVER key a user's own source term, rendering, definition, note, example
 * sentence, or anything an LLM extracted from the user's documents — those are
 * interpolated as `{placeholder}` values, verbatim, into the sentences below.
 * Every label, column header, empty state, status word, and action around them
 * IS keyed.
 *
 * `terminology.status.*` consolidates what used to be six independently
 * hand-copied `Record<RenderingStatus, string>` maps (GlossaryRow,
 * TerminologyTermDetail, TerminologyMergeDialog, TerminologyReviewQueue,
 * EquivalentsPanel, TermLookupPopover) — one of which (TermLookupPopover) had
 * drifted to "avoid" for forbidden while the other five said "forbidden".
 * Consolidated to "forbidden" (the 5-of-6 majority, and the same word the
 * underlying `RenderingStatus` machine id already uses). The single source of
 * truth for resolving a status to its key is `renderingStatusLabelKey()` in
 * `src/lib/terminology/types.ts` — mirrors the `roleNameKey()` pattern in
 * `src/lib/frontier/roles.ts`: the machine id (`RenderingStatus` itself) is
 * NEVER translated directly since rule-compilation and sorting compare against
 * it; only the resolved label passed through `t()` is.
 */
export const terminology = defineNamespace({
  keys: {
    // ── Rendering-status vocabulary (shared across 6 components) ───────────
    "terminology.status.preferred": "required",
    "terminology.status.admitted": "alternate",
    "terminology.status.forbidden": "forbidden",

    // ── Shared vocabulary reused across 2+ components ───────────────────────
    "terminology.common.noRenderings": "no renderings",
    "terminology.common.columnVerdict": "Verdict",
    "terminology.common.statusApproved": "approved",
    "terminology.common.statusSuggested": "suggested",
    "terminology.common.statusOld": "old",
    "terminology.common.managed": "Managed",
    "terminology.common.occurrenceCount": plural({
      one: "{count} occurrence",
      other: "{count} occurrences",
    }),

    // ── GlossaryEditor.tsx ───────────────────────────────────────────────────
    "terminology.editor.loadingGlossary": "Loading terminology",
    "terminology.editor.loadingTermDetails": "Loading term details",
    "terminology.editor.errorRequiresProjectLead":
      "Requires Project Lead role or higher to manage the terminology.",
    "terminology.editor.errorConflict":
      "The terminology changed elsewhere. Review the latest terms and try again.",
    "terminology.editor.errorOffline": "Terminology changes will sync when you reconnect.",
    "terminology.editor.errorBlocked": "Your role cannot change the terminology.",
    "terminology.editor.errorSourceAndRenderingRequired":
      "A source term and rendering are required before the term can be active.",
    "terminology.editor.errorImportFailed": "Import failed",
    "terminology.editor.findingTerms": "Finding terms…",
    "terminology.editor.suggestTerms": "Suggest terms",
    "terminology.editor.exportCsv": "Export CSV",
    "terminology.editor.exportTbx": "Export TBX",
    "terminology.editor.backToGlossary": "Back to terminology",
    "terminology.editor.addTerm": "Add term",
    "terminology.editor.addTermDescription":
      "Create a source term and its preferred rendering for this project terminology.",
    "terminology.editor.sourceTermLabel": "Source term",
    "terminology.editor.sourceTermPlaceholder": "New source term…",
    "terminology.editor.renderingLabel": "Rendering",
    "terminology.editor.checkingTerminology": "Checking terminology…",
    "terminology.editor.noTermsYet":
      "No terms yet. Add one with “Add term”, or use “Suggest terms”.",
    "terminology.editor.showArchived": plural({
      one: "Show archived ({count})",
      other: "Show archived ({count})",
    }),
    "terminology.editor.hideArchived": "Hide archived",

    // ── GlossaryRow.tsx ──────────────────────────────────────────────────────
    "terminology.row.notesAria": "Notes for {term}",
    "terminology.row.notesPlaceholder": "Contextual notes for translators",
    "terminology.row.sourceTermPlaceholder": "(source term)",
    "terminology.row.addRenderingPlaceholder": "(add rendering)",
    "terminology.row.renderingTextAria": "Rendering {position} text",
    "terminology.row.renderingStatusAria": "Rendering {position} status",
    "terminology.row.removeRenderingAria": "Remove rendering {position}",
    "terminology.row.collapseRenderingsAria": "Collapse renderings",
    "terminology.row.expandRenderingsAria": "Expand renderings",
    "terminology.row.openDetailsAria": "Open details for {term}",
    "terminology.row.acceptTermAria": "Accept term",
    "terminology.row.dismissTermAria": "Dismiss term",
    "terminology.row.archiveTermAria": "Archive term",
    "terminology.row.restoreTermAria": "Restore term",
    "terminology.row.noRenderingsYet": "No renderings yet.",
    "terminology.row.addRendering": "Add rendering",

    // ── LivingMemoryPage.tsx ─────────────────────────────────────────────────
    "terminology.livingMemory.title": "Living Memory",
    "terminology.livingMemory.introText":
      "Your team's encoded voice and standards — the project context the AI draws on " +
      "for every new draft. It grows with each validation, correction, and instruction " +
      "your team adds.",
    "terminology.livingMemory.loadingValidatedTranslations": "Loading validated translations",
    "terminology.livingMemory.noValidatedTranslationsAria": "No validated translations",
    "terminology.livingMemory.noValidatedTranslationsTitle": "No validated translations yet",
    "terminology.livingMemory.noValidatedTranslationsDescription":
      "When translators and reviewers reach the required validation threshold on a cell, " +
      "that source → target pair appears here. The AI draws on these pairs in every " +
      "subsequent draft.",
    "terminology.livingMemory.referenceAria": "Reference: {reference}",
    "terminology.livingMemory.translationAria": "Translation",
    "terminology.livingMemory.validatedByAria": "Validated by: {validators}",
    "terminology.livingMemory.enterTextPlaceholder": "Enter text…",
    "terminology.livingMemory.offlineTooltip": "You are offline. Reconnect to edit.",
    "terminology.livingMemory.maintainerRequiredTooltip":
      "Editing requires Maintainer role (600) or above.",
    "terminology.livingMemory.addEntryAria": "Add {section} entry",
    "terminology.livingMemory.exampleLabel": "Example:",
    "terminology.livingMemory.editEntryAria": "Edit entry",
    "terminology.livingMemory.deleteEntryAria": "Delete entry",
    "terminology.livingMemory.deleteEntryConfirmTitle": "Delete entry?",
    "terminology.livingMemory.deleteEntryConfirmDescription":
      "This will permanently remove the entry. This action cannot be undone.",
    "terminology.livingMemory.loadingCountAria": "Loading count",
    "terminology.livingMemory.validatedCount": plural({
      one: "{count} validated",
      other: "{count} validated",
    }),
    "terminology.livingMemory.goToTerminologyAria": "Go to Terminology page",
    "terminology.livingMemory.loadErrorPrefix": "Couldn't load the complete project memory: {message}",
    "terminology.livingMemory.instructionsTitle": "Instructions",
    "terminology.livingMemory.instructionsDescription":
      "Tell the AI what this project is about — audience, tone, formality, special " +
      "handling. These appear in every draft prompt.",
    "terminology.livingMemory.instructionsPlaceholder": "No instructions yet.",
    "terminology.livingMemory.instructionsExample":
      '"Translate into formal Swahili for an adult literacy audience. Avoid theological ' +
      'jargon unless the source uses it."',
    "terminology.livingMemory.standardsTitle": "Standards",
    "terminology.livingMemory.standardsDescription":
      "Project-wide quality rules the AI checks its drafts against. Capture decisions " +
      "your team keeps revisiting.",
    "terminology.livingMemory.standardsPlaceholder": "No standards yet.",
    "terminology.livingMemory.standardsExample":
      '"Always preserve proper nouns untranslated. Numbers in source must appear as ' +
      'numerals in target."',
    "terminology.livingMemory.recentExamplesTitle": "Recent Examples",
    "terminology.livingMemory.recentExamplesDescription":
      "Human-validated source→target pairs the AI uses as in-context examples. These " +
      "are the translations your team has agreed on.",
    // Settings-style IA (index → detail): section rows + pane chrome. Reused
    // keys (no duplicates added): the instructions section title is
    // instructionsTitle above, `knowledge` reuses knowledgeBase.title/
    // .description, `examples` reuses recentExamplesDescription, the quality
    // rule-count hint reuses rules.checkDrawer.scopeRules, and the prompt
    // reset button reuses onboarding.checklist.aiInstructions.resetToDefault.
    "terminology.livingMemory.section.brief.title": "Brief",
    "terminology.livingMemory.section.brief.description":
      "Audience, purpose, and scope of this translation",
    "terminology.livingMemory.section.brief.statusNone": "Not started",
    "terminology.livingMemory.section.brief.statusDraft": "Draft",
    "terminology.livingMemory.section.brief.statusComplete": "Complete",
    "terminology.livingMemory.section.instructions.description":
      "How the AI should behave when drafting, and the default prediction prompt",
    "terminology.livingMemory.section.instructions.entryCount": plural({
      one: "{count} entry",
      other: "{count} entries",
    }),
    "terminology.livingMemory.section.instructions.customPromptHint": "Custom prompt",
    "terminology.livingMemory.section.quality.title": "Translation quality",
    "terminology.livingMemory.section.quality.description":
      "Standards, style rules, and checks that guard the translation",
    "terminology.livingMemory.section.knowledge.hintOn": "On",
    "terminology.livingMemory.section.knowledge.hintOff": "Off",
    "terminology.livingMemory.section.examples.title": "Examples",
    // Default-prediction-prompt block (instructions pane, collapsed by default).
    "terminology.livingMemory.prompt.defaultBadge": "Default",
    "terminology.livingMemory.prompt.customBadge": "Custom",

    // ── TerminologyTermDetail.tsx ────────────────────────────────────────────
    "terminology.termDetail.closeAria": "Close detail",
    "terminology.termDetail.verdictNa": "n/a",
    "terminology.termDetail.verdictEnforced": "enforced",
    "terminology.termDetail.verdictInfringed": "infringed",
    "terminology.termDetail.noOccurrences": "No occurrences found in the loaded cells.",
    "terminology.termDetail.columnRef": "Ref",
    "terminology.termDetail.enforcedCount": plural({
      one: "{count} enforced",
      other: "{count} enforced",
    }),
    "terminology.termDetail.infringedCount": plural({
      one: "{count} infringed",
      other: "{count} infringed",
    }),

    // ── TerminologyMergeDialog.tsx ───────────────────────────────────────────
    "terminology.mergeDialog.title": "Merge duplicate concepts",
    "terminology.mergeDialog.selectDescription":
      "Select 2 or more concepts to merge. The first selected concept becomes the " +
      "survivor and keeps its id. All renderings are combined.",
    "terminology.mergeDialog.survivorBadge": "survivor",
    "terminology.mergeDialog.mergeFailed": "Merge failed",
    "terminology.mergeDialog.previewMergeButton": "Preview merge",
    "terminology.mergeDialog.previewDescription":
      "Review the merged concept before confirming. Merged-away concepts will be " +
      "removed permanently.",
    "terminology.mergeDialog.survivorLabel": "Survivor (keeps id)",
    "terminology.mergeDialog.mergedRenderingsLabel": "Merged renderings",
    "terminology.mergeDialog.combinedNotesLabel": "Combined notes",
    "terminology.mergeDialog.conceptsToRemoveLabel": "Concepts to remove",
    "terminology.mergeDialog.merging": "Merging…",
    "terminology.mergeDialog.confirmMerge": "Confirm merge",

    // ── TerminologyReviewQueue.tsx ───────────────────────────────────────────
    "terminology.reviewQueue.approveAria": "Approve concept {term}",
    "terminology.reviewQueue.rejectAria": "Reject concept {term}",
    // "Read-only" permission badge → common.readOnly (identical text)
    "terminology.reviewQueue.readOnlyTooltip":
      "Requires Project Lead role or higher to approve/reject concepts.",
    "terminology.reviewQueue.emptyTitle": "No concepts awaiting review.",
    "terminology.reviewQueue.emptyDescription":
      "Draft concepts promoted from candidates will appear here.",
    "terminology.reviewQueue.awaitingReviewCount": plural({
      one: "concept awaiting review",
      other: "concepts awaiting review",
    }),

    // ── EquivalentsPanel.tsx ─────────────────────────────────────────────────
    "terminology.equivalents.sourceBoth": "χ² + EM agree",
    "terminology.equivalents.sourceEm": "EM only",
    "terminology.equivalents.sourceChi2": "χ² only",
    "terminology.equivalents.promoteTooltip":
      "Promote to a managed rendering (crosses the deterministic line)",
    "terminology.equivalents.promoteButton": "Promote",
    "terminology.equivalents.managedSubtitle": "(your decisions)",
    "terminology.equivalents.noManagedRenderings": "No managed renderings yet for “{term}”.",
    "terminology.equivalents.aiAssumedHeading": "AI-assumed",
    "terminology.equivalents.aiAssumedSubtitle": "(predicted)",
    "terminology.equivalents.noPredicted":
      "No predicted equivalents — the corpus has too little signal yet.",
    "terminology.equivalents.confidenceHigh": "HIGH",
    "terminology.equivalents.confidenceAmber": "AMBER",
    "terminology.equivalents.confidenceLow": "LOW",

    // ── TermLookupPopover.tsx ────────────────────────────────────────────────
    "terminology.lookup.applyAria": "Apply rendering: {rendering}",
    "terminology.lookup.applyButton": "Apply",
    "terminology.lookup.tooltipAria": 'Terminology lookup for "{term}"',

    // ── TerminologyViolationsInbox.tsx ───────────────────────────────────────
    "terminology.violations.title": "Violations",
    "terminology.violations.summary": plural(
      {
        one: "{total} across {count} concept",
        other: "{total} across {count} concepts",
      },
    ),
    "terminology.violations.description":
      "Terminology infractions derived on read over the loaded project cells, grouped " +
      "by concept. Missing-approved = the source bears the concept but the target has " +
      "no approved rendering. Forbidden-present = a forbidden rendering appears in the " +
      "target.",
    "terminology.violations.emptyTitle": "No terminology violations.",
    "terminology.violations.emptyDescriptionPre": "Only",
    "terminology.violations.emptyDescriptionPost":
      "concepts with renderings are enforced — set a concept's status to approved to " +
      "start checking.",
    "terminology.violations.kindMissing": "missing",
    "terminology.violations.missingCount": plural({
      one: "{count} missing",
      other: "{count} missing",
    }),
    "terminology.violations.forbiddenCount": plural({
      one: "{count} forbidden",
      other: "{count} forbidden",
    }),

    // ── CandidateTermsPanel.tsx ──────────────────────────────────────────────
    "terminology.candidates.emptyTitle": "No candidate terms",
    "terminology.candidates.emptyDescription": "No candidate terms found in the loaded cells.",
    "terminology.candidates.countRankedByNc": plural({
      one: "{count} candidate term, ranked by NC-value",
      other: "{count} candidate terms, ranked by NC-value",
    }),
    "terminology.candidates.ngramLength": plural({
      one: "{count} word",
      other: "{count} words",
    }),
    "terminology.candidates.ncTooltip":
      "NC-value — termhood with context weighting (default rank)",
    "terminology.candidates.cTooltip": "C-value — nestedness-adjusted termhood",
    "terminology.candidates.g2Tooltip":
      "G² keyness — how unexpectedly frequent vs the reference corpus",
    "terminology.candidates.promoteButton": "Promote to managed",

    // ── ProjectSettings/TermbaseSharingSection.tsx ───────────────────────────
    "terminology.sharing.title": "Termbase Sharing",
    "terminology.sharing.notOrgOwnedDescription":
      "Term base sharing is available for org-owned projects only. Move this project " +
      "into an organization to publish or subscribe to shared term bases.",
    "terminology.sharing.publishLabel": "Publish this term base to the org",
    "terminology.sharing.publishDescription":
      "Lets other projects in your organization subscribe to this project's approved " +
      "terms.",
    "terminology.sharing.publishAria": "Publish term base to org",
    "terminology.sharing.needsMaintainer":
      "Maintainer (or higher) on an org-owned project is required to manage term base " +
      "sharing.",
    "terminology.sharing.subscribedLabel": "Subscribed term bases",
    "terminology.sharing.subscribedHint": "(drag to set priority — top = highest precedence)",
    "terminology.sharing.loadingSubscriptions": "Loading subscriptions…",
    "terminology.sharing.noneSubscribed": "Not subscribed to any term bases yet.",
    "terminology.sharing.upstreamUnpublished": "upstream unpublished",
    "terminology.sharing.unsubscribeAria": "Unsubscribe from {name}",
    "terminology.sharing.availableLabel": "Available in your org",
    "terminology.sharing.noneAvailable": "No other published term bases in your organization.",
    "terminology.sharing.subscribeButton": "Subscribe",

    // ── src/lib/terminology/compile.ts (rule-engine frame text) ──────────────
    "terminology.compile.ruleName": "Term: {term}",
    "terminology.compile.ruleNameForbidden": "Term: {term} — forbidden rendering",
    "terminology.compile.approvedRequired":
      '"{term}" must be rendered with an approved rendering ({renderings})',
    "terminology.compile.forbiddenRendering":
      '"{rendering}" is a forbidden rendering for "{term}"',

    // ── src/lib/terminology/store.ts (mergeConcepts invariant guards) ────────
    "terminology.store.mergeMinConcepts": "mergeConcepts requires at least 2 concept ids.",
    "terminology.store.survivorNotInMergeIds": "survivorId must be one of the mergeIds.",
    "terminology.store.conceptNotFound": "Concept {id} not found.",

    // ── Shared field labels reused across TerminologyPage.tsx's own dialogs ──
    "terminology.common.notesLabel": "Notes",
    "terminology.common.statusLabel": "Status",

    // ── AddConceptDialog.tsx ("Add to term base" confirm dialog) ────────────
    "terminology.addConcept.title": "Add to term base",
    "terminology.addConcept.description":
      "Creates a draft concept with this source term. Add renderings and " +
      "activate it from the Terminology page.",
    "terminology.addConcept.sourceTermPlaceholder": "Source term…",
    "terminology.addConcept.sourceTermAriaLabel": "Source term for new concept",
    "terminology.addConcept.createDraftAriaLabel": "Create draft concept",

    // ── RenameSuggestionsDialog.tsx (bulk file/corpus rename suggestions) ───
    "terminology.renameSuggestions.title": "Review suggested names",
    "terminology.renameSuggestions.corpusChange": "Corpus: {current} → {suggested}",
    "terminology.renameSuggestions.applyButton": plural({
      one: "Apply {count} change",
      other: "Apply {count} changes",
    }),

    // ── TerminologyPage.tsx: ConceptDialog (add/edit concept form) ──────────
    "terminology.conceptDialog.renderingPlaceholder": "rendering",
    "terminology.conceptDialog.targetRenderingsLabel": "Target renderings",

    // ── TerminologyPage.tsx: ConceptRow (main concepts table row) ───────────
    "terminology.page.editConceptAria": "Edit concept {term}",
    "terminology.page.deleteConceptAria": "Delete concept {term}",

    // ── TerminologyPage.tsx: tab strip (counted variants of the tab labels
    // below reuse terminology.page.conceptsHeading / reviewQueueHeading /
    // candidateTermsHeading / terminology.violations.title for the bare and
    // "Concepts (N)" forms — these two are only for the "N pending" forms
    // those keys don't cover) ────────────────────────────────────────────
    "terminology.page.reviewQueueCountLabel": "Review queue ({count})",
    "terminology.page.candidateTermsCountLabel": "Candidate terms ({count})",

    // ── TerminologyPage.tsx: TermbaseImportDialog ────────────────────────────
    "terminology.importDialog.title": "Import term base",
    "terminology.importDialog.parsing": "Parsing…",
    "terminology.importDialog.dropZoneText": "Drop a .{format} file here, or",
    "terminology.importDialog.chooseFileButton": "Choose {format} file",
    "terminology.importDialog.csvColumnsHint":
      "Columns: source_lemma · target_lemma · target_status · definition (optional)",
    "terminology.importDialog.tbxDialectsHint": "TBX-Basic and TBX-Min dialects supported",

    // ── TerminologyPage.tsx: LibraryStatsHeader ──────────────────────────────
    "terminology.libraryStats.heading": "Library Overview",
    "terminology.libraryStats.noActiveConcepts": "(no active concepts)",
    "terminology.libraryStats.activeConceptsLabel": "Active concepts",
    "terminology.libraryStats.enforcedLabel": "Enforced",
    "terminology.libraryStats.infringedLabel": "Infringed",
    "terminology.libraryStats.cellsAnalyzedLabel": "Cells analyzed",
    "terminology.libraryStats.mostInfringedLabel": "Most infringed",

    // ── TerminologyPage.tsx: candidate-terms tab intro paragraph ────────────
    "terminology.candidates.minedFromSummary": plural({
      one:
        "Mined from {count} source/WIP cell text{note}. Mining runs off the main " +
        "thread. Keyness (G²) uses a derived rest-of-corpus baseline. Promoting " +
        "adds a suggested concept you can then give renderings.",
      other:
        "Mined from {count} source/WIP cell texts{note}. Mining runs off the main " +
        "thread. Keyness (G²) uses a derived rest-of-corpus baseline. Promoting " +
        "adds a suggested concept you can then give renderings.",
    }),
    "terminology.candidates.corpusScopeFull": " — the full loaded project",
    "terminology.candidates.corpusScopeCapped":
      " (capped at the first {ceiling} of {total} loaded cells — corpus exceeds the safety ceiling)",
    "terminology.candidates.miningLabel": "Mining candidate terms…",

    // ── TerminologyPage.tsx: main page chrome ────────────────────────────────
    "terminology.loadingLabel": "Loading terminology",
    "terminology.page.addConceptButton": "Add concept",
    "terminology.page.editConceptTitle": "Edit concept",
    "terminology.page.deleteConcept":
      "Delete this concept? This removes it for everyone in the project and cannot be undone.",
    "terminology.page.deleteNamedConcept":
      'Delete "{term}"? This removes the concept and all its renderings for everyone in the project and cannot be undone.',
    "terminology.page.mergeDuplicatesButton": "Merge duplicates",
    "terminology.page.reviewQueueHeading": "Review queue",
    "terminology.page.candidateTermsHeading": "Candidate terms",
    "terminology.page.conceptsHeading": "Concepts ({count})",
    "terminology.page.noConceptsTitle": "No concepts yet.",
    "terminology.page.noConceptsDescription": "Add a concept manually or import a CSV / TBX file.",
    "terminology.page.addFirstConceptButton": "Add first concept",
    "terminology.page.renderingsColumnHeader": "Renderings",
    "terminology.page.deleteConceptDialogTitle": "Delete concept",
  },
  context: {
    _context: {
      description:
        "Termbase, glossary and translation memory — the translator's own reference " +
        "tooling, used continuously while translating rather than occasionally. Read in " +
        "the translator's language every working session. Never translate a user's own " +
        "source term, rendering, definition, note, or example sentence — those flow " +
        "through as {placeholder} values, verbatim, into the surrounding English " +
        "sentence, which IS translated.",
    },
    keys: {
      "terminology.termDetail.closeAria": {
        description: "Accessible name for the back/close button on the term detail header.",
      },
      "terminology.sharing.publishAria": {
        description: "Accessible name for the publish-to-org toggle switch.",
      },
      "terminology.editor.showArchived": {
        description:
          "Toggle button revealing archived (deprecated) glossary terms; {count} is the " +
          "archived-term count. English has no grammatical plural form here, but the " +
          "count still needs its own CLDR category per locale.",
        placeholders: { count: "The archived-term count." },
      },
      "terminology.row.notesAria": {
        description:
          "Accessible name for a glossary row's notes textarea; {term} is the concept's " +
          "own source headword (never translated).",
        placeholders: { term: "The concept's source headword, verbatim (not translated)." },
      },
      "terminology.row.renderingTextAria": {
        description:
          "Accessible name for a rendering's text input inside the expanded row; " +
          "{position} is its 1-based position among the concept's renderings.",
        placeholders: { position: "1-based position of this rendering in the list." },
      },
      "terminology.row.renderingStatusAria": {
        description:
          "Accessible name for a rendering's status <select>; {position} is its 1-based " +
          "position among the concept's renderings.",
        placeholders: { position: "1-based position of this rendering in the list." },
      },
      "terminology.row.removeRenderingAria": {
        description:
          "Accessible name for the button removing one rendering; {position} is its " +
          "1-based position among the concept's renderings.",
        placeholders: { position: "1-based position of this rendering in the list." },
      },
      "terminology.row.collapseRenderingsAria": {
        description: "Accessible name for the row expander toggle when it is open.",
      },
      "terminology.row.expandRenderingsAria": {
        description: "Accessible name for the row expander toggle when it is closed.",
      },
      "terminology.row.openDetailsAria": {
        description:
          "Accessible name for the button opening a concept's drill-down detail view; " +
          "{term} is the concept's own source headword (never translated).",
        placeholders: { term: "The concept's source headword, verbatim (not translated)." },
      },
      "terminology.row.acceptTermAria": {
        description: "Accessible name for the checkmark button accepting a draft (suggested) term.",
      },
      "terminology.row.dismissTermAria": {
        description: "Accessible name for the button dismissing (deleting) a draft term.",
      },
      "terminology.row.archiveTermAria": {
        description: "Accessible name for the button archiving (deprecating) an active term.",
      },
      "terminology.row.restoreTermAria": {
        description: "Accessible name for the button restoring an archived (deprecated) term.",
      },
      "terminology.livingMemory.noValidatedTranslationsAria": {
        description:
          "Accessible label on the Recent Examples empty-state region, read before its " +
          "title/description text.",
      },
      "terminology.livingMemory.referenceAria": {
        description:
          "Accessible label naming the cell reference on a validated-example card; " +
          "{reference} is the cell's own reference string (e.g. a verse/segment id).",
        placeholders: { reference: "The cell's reference label, verbatim (not translated)." },
      },
      "terminology.livingMemory.translationAria": {
        description: "Accessible label on the target-text line of a validated-example card.",
      },
      "terminology.livingMemory.validatedByAria": {
        description:
          "Accessible label listing the validators on a validated-example card; " +
          "{validators} is a comma-joined list of usernames (not translated).",
        placeholders: { validators: "Comma-joined validator usernames, verbatim." },
      },
      "terminology.livingMemory.loadingCountAria": {
        description: "Accessible label on the skeleton shown while the validated-cell count loads.",
      },
      "terminology.livingMemory.addEntryAria": {
        description:
          "Accessible name for the 'Add' button in an Instructions/Standards section, " +
          "and the matching add-dialog's title; {section} is that section's own already-" +
          "translated lowercase name ('instructions' or 'standards').",
        placeholders: {
          section: "The section's translated name, lowercased ('instructions' or 'standards').",
        },
      },
      "terminology.livingMemory.editEntryAria": {
        description: "Accessible name for the pencil button editing one authored entry.",
      },
      "terminology.livingMemory.deleteEntryAria": {
        description: "Accessible name for the trash button deleting one authored entry.",
      },
      "terminology.livingMemory.validatedCount": {
        description:
          "Header badge showing how many cells have reached the validation threshold; " +
          "{count} is that count, already locale-formatted.",
        placeholders: { count: "The validated-cell count, already locale-formatted." },
      },
      "terminology.livingMemory.goToTerminologyAria": {
        description: "Accessible name for the toolbar button linking to the Terminology page.",
      },
      "terminology.livingMemory.loadErrorPrefix": {
        description:
          "Prefix before the raw error message when Living Memory fails to load cells; " +
          "{message} is the underlying error's own text (not translated).",
        placeholders: { message: "The underlying fetch error's message, verbatim." },
      },
      "terminology.livingMemory.section.brief.statusNone": {
        description:
          "Right-aligned hint on the Living Memory index's Brief row when no translation " +
          "brief has been authored yet. Sibling values: 'Draft', 'Complete'.",
      },
      "terminology.livingMemory.section.instructions.entryCount": {
        description:
          "Right-aligned hint on the Living Memory index's Instructions row: how many " +
          "authored instruction entries exist; {count} is that count, already " +
          "locale-formatted.",
        placeholders: { count: "The instruction-entry count, already locale-formatted." },
      },
      "terminology.livingMemory.section.instructions.customPromptHint": {
        description:
          "Appended to the Instructions row hint when the project overrides the default " +
          "AI prediction prompt (e.g. '2 entries · Custom prompt').",
      },
      "terminology.livingMemory.section.knowledge.hintOn": {
        description:
          "Right-aligned hint on the Living Memory index's Knowledge base row when the " +
          "knowledge base is used in drafting. Paired with the 'Off' hint.",
        maxLength: 12,
      },
      "terminology.livingMemory.section.knowledge.hintOff": {
        description:
          "Right-aligned hint on the Living Memory index's Knowledge base row when the " +
          "knowledge base is not used in drafting. Paired with the 'On' hint.",
        maxLength: 12,
      },
      "terminology.livingMemory.prompt.defaultBadge": {
        description:
          "Badge on the collapsed prediction-prompt row: the project uses the built-in " +
          "default prompt (adjective, one word). Paired with the 'Custom' badge.",
        maxLength: 16,
      },
      "terminology.livingMemory.prompt.customBadge": {
        description:
          "Badge on the collapsed prediction-prompt row: the project overrides the " +
          "default prompt (adjective, one word). Paired with the 'Default' badge.",
        maxLength: 16,
      },
      "terminology.common.occurrenceCount": {
        description:
          "Generic occurrence-count stat, reused for both the term detail header " +
          "(cells containing a concept's source term) and a candidate-term row (times " +
          "it occurs in the loaded corpus); {count} is that count.",
        placeholders: { count: "The occurrence count." },
      },
      "terminology.termDetail.enforcedCount": {
        description:
          "Stat line on the term detail header: how many occurrences use an approved " +
          "rendering; {count} is that count.",
        placeholders: { count: "Number of occurrences using an approved rendering." },
      },
      "terminology.termDetail.infringedCount": {
        description:
          "Stat line on the term detail header: how many occurrences violate the " +
          "concept's approved/forbidden renderings; {count} is that count.",
        placeholders: { count: "Number of occurrences that violate the concept's renderings." },
      },
      "terminology.reviewQueue.approveAria": {
        description:
          "Accessible name for the checkmark button approving a draft concept; {term} " +
          "is the concept's own source headword (not translated).",
        placeholders: { term: "The concept's source headword, verbatim (not translated)." },
      },
      "terminology.reviewQueue.rejectAria": {
        description:
          "Accessible name for the X button rejecting (deleting) a draft concept; {term} " +
          "is the concept's own source headword (not translated).",
        placeholders: { term: "The concept's source headword, verbatim (not translated)." },
      },
      "terminology.reviewQueue.awaitingReviewCount": {
        description:
          "Collapsible header phrase for the review queue, following a separate numeral " +
          "badge; no {count} placeholder appears in the text itself, but the locale's " +
          "CLDR category still must be selected from the same count.",
      },
      "terminology.equivalents.noManagedRenderings": {
        description:
          "Empty-state line in the Managed panel; {term} is the concept's own source " +
          "headword, shown inside curly quotes (not translated).",
        placeholders: { term: "The concept's source headword, verbatim (not translated)." },
      },
      "terminology.lookup.applyAria": {
        description:
          "Accessible name for the Apply button on one rendering row in the lookup " +
          "popover; {rendering} is the user's own rendering text (not translated).",
        placeholders: { rendering: "The rendering's own text, verbatim (not translated)." },
      },
      "terminology.lookup.tooltipAria": {
        description:
          "Accessible label on the popover's root region; {term} is the source-side " +
          "token the user hovered or clicked (not translated).",
        placeholders: { term: "The looked-up source token, verbatim (not translated)." },
      },
      "terminology.violations.summary": {
        description:
          "Inline count next to the Violations card title; {total} is the total " +
          "infraction count (not itself the selector — {count} of concepts is), {count} " +
          "is how many distinct concepts have at least one violation.",
        placeholders: {
          total: "Total infraction count across every concept, already formatted.",
          count: "Number of distinct concepts with at least one violation (the plural selector).",
        },
      },
      "terminology.violations.missingCount": {
        description:
          "Small chip on a concept's violation row: how many missing-approved-rendering " +
          "infractions it has; {count} is that count.",
        placeholders: { count: "Number of missing-approved-rendering infractions." },
      },
      "terminology.violations.forbiddenCount": {
        description:
          "Small chip on a concept's violation row: how many forbidden-rendering-present " +
          "infractions it has; {count} is that count.",
        placeholders: { count: "Number of forbidden-rendering-present infractions." },
      },
      "terminology.candidates.countRankedByNc": {
        description:
          "Header line above the ranked candidate-term list; {count} is the number of " +
          "candidates found.",
        placeholders: { count: "Number of candidate terms found." },
      },
      "terminology.candidates.ngramLength": {
        description:
          "Badge on a candidate-term row showing how many words the candidate spans; " +
          "{count} is that word count.",
        placeholders: { count: "Number of words the candidate term spans." },
      },
      "terminology.sharing.unsubscribeAria": {
        description:
          "Accessible name for the trash button removing one termbase subscription; " +
          "{name} is that termbase's own project/display name (not translated).",
        placeholders: { name: "The subscribed termbase's own display name, verbatim." },
      },
      "terminology.compile.ruleName": {
        description:
          "Internal rule-engine display name compiled for an approved-rendering " +
          "requirement, surfaced verbatim wherever a generic TranslationRule's `name` " +
          "renders (e.g. the org Rules surface); {term} is the concept's own source " +
          "headword (not translated).",
        placeholders: { term: "The concept's source headword, verbatim (not translated)." },
      },
      "terminology.compile.ruleNameForbidden": {
        description:
          "Same as terminology.compile.ruleName, for the per-forbidden-rendering rule " +
          "variant; {term} is the concept's own source headword (not translated).",
        placeholders: { term: "The concept's source headword, verbatim (not translated)." },
      },
      "terminology.compile.approvedRequired": {
        description:
          "Rule description compiled for a concept's approved-rendering requirement, " +
          "surfaced in the violation/rules UI; {term} is the concept's source headword " +
          "and {renderings} is a comma-joined list of the user's own approved renderings " +
          "— neither is translated.",
        placeholders: {
          term: "The concept's source headword, verbatim (not translated).",
          renderings: "Comma-joined list of the user's own approved renderings, verbatim.",
        },
      },
      "terminology.compile.forbiddenRendering": {
        description:
          "Rule description compiled for one forbidden rendering, surfaced in the " +
          "violation/rules UI; {rendering} and {term} are the user's own text, not " +
          "translated.",
        placeholders: {
          rendering: "The forbidden rendering's own text, verbatim (not translated).",
          term: "The concept's source headword, verbatim (not translated).",
        },
      },
      "terminology.store.conceptNotFound": {
        description:
          "Thrown when mergeConcepts() is asked to merge a concept id that no longer " +
          "exists — an invariant guard, not an expected user-facing flow; {id} is the " +
          "missing concept's own id (not translated).",
        placeholders: { id: "The missing concept's own id, verbatim (not translated)." },
      },
      "terminology.common.notesLabel": {
        description:
          "Field label for the free-text notes field on a concept — used both as the " +
          "'Add/edit concept' dialog's field label and as the concepts table's column " +
          "heading. 'Notes' here means translator-facing usage guidance for the term, " +
          "not code comments.",
      },
      "terminology.common.statusLabel": {
        description:
          "Field label for a concept's review status (draft/active/deprecated) — used " +
          "both as the 'Add/edit concept' dialog's select label and as the concepts " +
          "table's column heading. Terminology status, not a system/network status.",
      },
      "terminology.addConcept.title": {
        description:
          "Title of the confirm dialog shown when the user selects source text and " +
          "chooses 'Add to term base' — creates a draft concept from the selection. " +
          "'Term base' is this project's terminology/glossary store.",
      },
      "terminology.addConcept.description": {
        description:
          "Body text under the 'Add to term base' dialog title, explaining what " +
          "confirming will do: create a draft concept the user can flesh out later on " +
          "the Terminology page.",
      },
      "terminology.addConcept.sourceTermPlaceholder": {
        description:
          "Placeholder text in the empty source-term input of the 'Add to term base' " +
          "dialog, before the user has typed or the selection has pre-filled it.",
      },
      "terminology.addConcept.sourceTermAriaLabel": {
        description:
          "Accessible name for the source-term input in the 'Add to term base' dialog. " +
          "The field also has a visible label (terminology.common's 'Source term' — see " +
          "terminology.editor.sourceTermLabel), but this aria-label is the value " +
          "react-aria/the input actually announces, so it must independently read as a " +
          "complete description of the field.",
      },
      "terminology.addConcept.createDraftAriaLabel": {
        description:
          "Accessible name for the primary submit button in the 'Add to term base' " +
          "dialog. The button's visible text toggles to a busy 'Saving…' label while " +
          "the request is in flight; this accessible name states what the button DOES " +
          "regardless of that transient visible state.",
      },
      "terminology.renameSuggestions.title": {
        description:
          "Dialog title for reviewing a batch of AI-suggested file renames (and, where " +
          "applicable, corpus reassignments) detected from file content.",
      },
      "terminology.renameSuggestions.corpusChange": {
        description:
          "Small caption under a rename suggestion, shown only when the suggestion also " +
          "moves the file to a different corpus grouping. 'Corpus' here is a file-" +
          "labeling/grouping term (a named collection of files), not a linguistics " +
          "corpus.",
        placeholders: {
          current: "The file's current corpus name, or an em dash placeholder if unset — not translated.",
          suggested: "The suggested new corpus name — not translated.",
        },
      },
      "terminology.renameSuggestions.applyButton": {
        description:
          "Primary button applying the checked rename suggestions; {count} is how many " +
          "are currently checked.",
        placeholders: { count: "Number of rename suggestions currently checked." },
      },
      "terminology.conceptDialog.renderingPlaceholder": {
        description:
          "Placeholder text in an empty rendering-text input, inside the add/edit " +
          "concept dialog's list of target renderings. A generic noun naming what goes " +
          "in the field, not an example value.",
      },
      "terminology.conceptDialog.targetRenderingsLabel": {
        description:
          "Field label over the list of target-language renderings in the add/edit " +
          "concept dialog — each rendering is one approved/alternate/forbidden " +
          "translation of the source term.",
      },
      "terminology.page.editConceptAria": {
        description:
          "Accessible name for the pencil button opening the edit-concept dialog on a " +
          "concepts-table row; {term} is the concept's own source headword (not translated).",
        placeholders: { term: "The concept's source headword, verbatim (not translated)." },
      },
      "terminology.page.deleteConceptAria": {
        description:
          "Accessible name for the trash button opening the delete-concept confirm dialog " +
          "on a concepts-table row; {term} is the concept's own source headword (not translated).",
        placeholders: { term: "The concept's source headword, verbatim (not translated)." },
      },
      "terminology.page.reviewQueueCountLabel": {
        description:
          "Tab-strip button label for the review-queue tab once it has at least one draft " +
          "concept awaiting review; falls back to the bare terminology.page.reviewQueueHeading " +
          "text when the count is zero.",
        placeholders: { count: "Number of draft concepts awaiting review." },
      },
      "terminology.page.candidateTermsCountLabel": {
        description:
          "Tab-strip button label for the candidate-terms tab once mining has produced " +
          "results; falls back to the bare terminology.page.candidateTermsHeading text " +
          "before mining has run.",
        placeholders: { count: "Number of mined candidate terms." },
      },
      "terminology.importDialog.title": {
        description:
          "Title of the dialog for bulk-importing terms into the project's term base " +
          "from a CSV or TBX file.",
      },
      "terminology.importDialog.parsing": {
        description: "Transient status shown in the import dialog's drop zone while the dropped file is being parsed.",
      },
      "terminology.importDialog.dropZoneText": {
        description:
          "Instruction in the import dialog's drop zone, naming the currently-selected " +
          "file format tab's extension. Continues into a 'Choose {format} file' button " +
          "immediately after it, so keep this able to lead into a button label.",
        placeholders: {
          format: "The active tab's file extension without the dot, lowercase (e.g. 'csv', 'tbx').",
        },
      },
      "terminology.importDialog.chooseFileButton": {
        description: "Button opening the native file picker, naming the expected format.",
        placeholders: {
          format: "The active tab's file extension, uppercase (e.g. 'CSV', 'TBX').",
        },
      },
      "terminology.importDialog.csvColumnsHint": {
        description:
          "Small caption under the CSV import tab's drop zone, listing the expected " +
          "column names. The column names themselves (source_lemma, target_lemma, " +
          "target_status, definition) are the CSV format's own field identifiers — keep " +
          "them verbatim, do not translate them, only the surrounding words.",
      },
      "terminology.importDialog.tbxDialectsHint": {
        description:
          "Small caption under the TBX import tab's drop zone. 'TBX-Basic' and " +
          "'TBX-Min' are the names of specific TermBase eXchange format dialects — " +
          "proper names, keep verbatim.",
      },
      "terminology.libraryStats.heading": {
        description: "Small heading over the Terminology page's summary stats panel.",
      },
      "terminology.libraryStats.noActiveConcepts": {
        description:
          "Parenthetical qualifier shown beside the stats panel heading when the " +
          "project has zero active concepts yet, so the stats below all read as " +
          "placeholders.",
      },
      "terminology.libraryStats.activeConceptsLabel": {
        description: "Stat-tile label above the count of active (non-draft, non-deprecated) concepts.",
      },
      "terminology.libraryStats.enforcedLabel": {
        description:
          "Stat-tile label above the percentage of scanned occurrences using an " +
          "approved rendering. Distinct from terminology.termDetail.verdictEnforced " +
          "(a lowercase inline verdict word on one occurrence) — this is a stat-tile " +
          "heading and may need different capitalization/register in the target " +
          "language.",
      },
      "terminology.libraryStats.infringedLabel": {
        description:
          "Stat-tile label above the percentage of scanned occurrences that violate a " +
          "concept's approved/forbidden renderings. Distinct from " +
          "terminology.termDetail.verdictInfringed for the same reason as the Enforced " +
          "label above.",
      },
      "terminology.libraryStats.cellsAnalyzedLabel": {
        description: "Stat-tile label above the total count of cells the terminology scan covered.",
      },
      "terminology.libraryStats.mostInfringedLabel": {
        description: "Small heading over the list of the concepts with the most violations, shown when any exist.",
      },
      "terminology.candidates.minedFromSummary": {
        description:
          "Intro paragraph above the candidate-terms tab's ranked list, stating how " +
          "many cells the term-mining pass covered and how it works. {note} is a whole " +
          "already-localized trailing clause (see terminology.candidates.corpusScopeFull " +
          "/ corpusScopeCapped) — insert it exactly where the placeholder sits, it " +
          "already carries its own leading space/punctuation. Plural category is chosen " +
          "by {count}.",
        placeholders: {
          count: "Number of cells the mining pass covered; also selects the plural form.",
          note:
            "Already-localized trailing clause naming the scan's scope — either " +
            "terminology.candidates.corpusScopeFull or ...corpusScopeCapped, verbatim " +
            "including its own leading space.",
        },
      },
      "terminology.candidates.corpusScopeFull": {
        description:
          "Trailing clause appended into terminology.candidates.minedFromSummary when " +
          "the mining pass covered the whole loaded project (not capped). Keep the " +
          "leading space — it is the only separator between this clause and the word " +
          "it follows.",
      },
      "terminology.candidates.corpusScopeCapped": {
        description:
          "Trailing clause appended into terminology.candidates.minedFromSummary when " +
          "the loaded corpus exceeded the mining safety ceiling and was truncated. Keep " +
          "the leading space — it is the only separator between this clause and the " +
          "word it follows.",
        placeholders: {
          ceiling: "The fixed safety-ceiling cell count the scan capped at.",
          total: "The total number of loaded cells before capping.",
        },
      },
      "terminology.candidates.miningLabel": {
        description: "Transient status shown while the candidate-term mining pass is running off the main thread.",
      },
      "terminology.loadingLabel": {
        description:
          "Loading-panel label shown while the Terminology surface's initial data " +
          "is still loading. Rendered from two places for the same surface — the " +
          "Terminology page itself and the workspace shell's Suspense fallback — " +
          "so it is worded without naming either container.",
      },
      "terminology.page.deleteNamedConcept": {
        description:
          "Body of the confirmation asked before deleting a terminology concept, " +
          "when the concept has a source term to name. Full sentence, ends with a " +
          "period. States the blast radius (everyone in the project) and that it " +
          "cannot be undone — do not soften either. The term is quoted.",
        placeholders: {
          term: "The concept's source term, shown in quotes so it is clear which one is going.",
        },
      },
      "terminology.page.addConceptButton": {
        description: "Header button opening the add-concept dialog.",
      },
      "terminology.page.mergeDuplicatesButton": {
        description:
          "Button opening the merge-duplicate-concepts dialog, shown only once the " +
          "project has 2+ concepts. Visible text; distinct from the same button's " +
          "accessible name (terminology.mergeDialog.title, reused here since identical).",
      },
      "terminology.page.reviewQueueHeading": {
        description:
          "Card heading over the review-queue tab's content (draft concepts awaiting " +
          "approval); also the tab-strip button's own label when there are zero pending " +
          "concepts (see terminology.page.reviewQueueCountLabel for the counted form).",
      },
      "terminology.page.candidateTermsHeading": {
        description:
          "Card heading over the candidate-terms tab's content (mined term suggestions); " +
          "also the tab-strip button's own label before mining has produced results (see " +
          "terminology.page.candidateTermsCountLabel for the counted form).",
      },
      "terminology.page.conceptsHeading": {
        description:
          "Card heading over the main concepts list/table, with the total concept count; " +
          "also reused verbatim as the tab-strip button's own label for the same tab.",
        placeholders: { count: "Total number of concepts in the project's term base." },
      },
      "terminology.page.noConceptsTitle": {
        description: "Empty-state title shown when the project's term base has no concepts yet.",
      },
      "terminology.page.noConceptsDescription": {
        description: "Empty-state body text under terminology.page.noConceptsTitle, suggesting how to add the first concept.",
      },
      "terminology.page.addFirstConceptButton": {
        description: "Empty-state call-to-action button opening the add-concept dialog.",
      },
      "terminology.page.renderingsColumnHeader": {
        description: "Column heading over the renderings column in the concepts table.",
      },
      "terminology.page.deleteConceptDialogTitle": {
        description:
          "Title of the checkbox-confirm dialog shown before permanently deleting a " +
          "concept and all its renderings.",
      },
    },
  },
  surfaces: [],
})
