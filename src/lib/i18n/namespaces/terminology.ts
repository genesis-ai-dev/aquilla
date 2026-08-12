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
    "terminology.editor.loadingGlossary": "Loading glossary",
    "terminology.editor.loadingTermDetails": "Loading term details",
    "terminology.editor.errorRequiresProjectLead":
      "Requires Project Lead role or higher to manage the glossary.",
    "terminology.editor.errorConflict":
      "The glossary changed elsewhere. Review the latest terms and try again.",
    "terminology.editor.errorOffline": "Glossary changes will sync when you reconnect.",
    "terminology.editor.errorBlocked": "Your role cannot change the glossary.",
    "terminology.editor.errorSourceAndRenderingRequired":
      "A source term and rendering are required before the term can be active.",
    "terminology.editor.errorImportFailed": "Import failed",
    "terminology.editor.title": "Glossary",
    "terminology.editor.findingTerms": "Finding terms…",
    "terminology.editor.suggestTerms": "Suggest terms",
    "terminology.editor.exportCsv": "Export CSV",
    "terminology.editor.exportTbx": "Export TBX",
    "terminology.editor.backToGlossary": "Back to glossary",
    "terminology.editor.addTerm": "Add term",
    "terminology.editor.addTermDescription":
      "Create a source term and its preferred rendering for this project glossary.",
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
    "terminology.reviewQueue.readOnly": "Read-only",
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
        description: "Accessible name for the toolbar button linking to the Glossary page.",
      },
      "terminology.livingMemory.loadErrorPrefix": {
        description:
          "Prefix before the raw error message when Living Memory fails to load cells; " +
          "{message} is the underlying error's own text (not translated).",
        placeholders: { message: "The underlying fetch error's message, verbatim." },
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
    },
  },
  surfaces: [],
})
