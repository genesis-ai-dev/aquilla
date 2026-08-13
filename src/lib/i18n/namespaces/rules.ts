import { defineNamespace, plural } from "./types"

/**
 * `rules` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `rules.` — the namespace's name is derived
 * from its first key, not from the filename.
 *
 * NEVER translate (content, not chrome): the user's OWN rule `name` /
 * `description`, autofix pattern/replacement/flags, every `RuleCheck`
 * pattern, `concept.sourceTerm`, matched cell text. The ten BUILT-IN checks
 * are the one ambiguous case — `resolveBuiltinRules()` copies
 * `BUILTIN_CHECKS[id].name`/`.description` onto a `TranslationRule` so four
 * renderers can't structurally tell a built-in from a user rule apart. Those
 * ARE chrome (the app authored them, not a user), keyed here under
 * `rules.builtin.<id>.*` and resolved at render off the rule's
 * `builtin:`-prefixed id — see `translateRuleName`/`translateRuleDescription`
 * in `src/lib/lqa/builtin-resolver.ts`.
 *
 * `rules.infraction.*` is the OTHER half of the same split: `RuleInfraction`
 * used to carry a pre-composed English sentence (`"${rule.name}": predicate`)
 * built in `rule-engine.ts`, a pure locale-less function. It now returns a
 * `reason` code + `reasonParams` instead, and `src/lib/rules/format-infraction.ts`
 * composes the sentence at render via `t()`. `reasonParams.tokens` (placeholder
 * integrity) is raw `matchedText` from the cell — interpolated as a var, never
 * translated.
 */
export const rules = defineNamespace({
  keys: {
    // ── Infraction messages (rule-engine reason codes → predicate text) ────
    "rules.infraction.withRuleName": '"{ruleName}": {message}',
    "rules.infraction.targetForbids": "target contains forbidden pattern",
    "rules.infraction.sourceRequiresTarget": "source matches pattern but target does not",
    "rules.infraction.sourceTargetMatch": "pattern found in source but missing in target",
    "rules.infraction.builtin.emptyTarget": "Source has content but the translation is empty",
    "rules.infraction.builtin.targetEqualsSource": "Translation is identical to the source",
    "rules.infraction.builtin.numberIntegrity": "Number from source missing in translation",
    "rules.infraction.builtin.endPunctuationMismatch": "Terminal punctuation differs from source",
    "rules.infraction.builtin.punctuationIntegrity":
      "Clause punctuation from source missing in translation",
    "rules.infraction.builtin.doubleSpace": "Extra whitespace in translation",
    "rules.infraction.builtin.repeatedWord": "Word repeated in translation",
    "rules.infraction.builtin.unpairedSymbols": "Unpaired bracket/parenthesis/brace in translation",
    "rules.infraction.builtin.abbreviationMismatch": "Abbreviation from source missing in translation",
    "rules.infraction.builtin.placeholderIntegrity": plural({
      one: "Placeholder {tokens} missing in translation",
      other: "Placeholders {tokens} missing in translation",
    }),

    // ── Built-in check name/description (resolveBuiltinRules registry) ─────
    "rules.builtin.emptyTarget.name": "Empty translation",
    "rules.builtin.emptyTarget.description":
      "Source has content but the translation is blank or whitespace-only.",
    "rules.builtin.targetEqualsSource.name": "Identical to source",
    "rules.builtin.targetEqualsSource.description":
      "Translation matches the source verbatim — likely untranslated.",
    "rules.builtin.placeholderIntegrity.name": "Placeholder integrity",
    "rules.builtin.placeholderIntegrity.description":
      "Tokens like {name}, <tag>, %s, \\n in source must appear in target.",
    "rules.builtin.numberIntegrity.name": "Number integrity",
    "rules.builtin.numberIntegrity.description":
      "Numerals in source must appear in target (locale separators are tolerated).",
    "rules.builtin.endPunctuationMismatch.name": "End punctuation",
    "rules.builtin.endPunctuationMismatch.description":
      "Source ends in ?/!/. — translation should end the same way.",
    "rules.builtin.punctuationIntegrity.name": "Punctuation integrity",
    "rules.builtin.punctuationIntegrity.description":
      "Clause punctuation (: or ;) in the source should also appear in the translation — catches mid-cell drops the end-punctuation check misses.",
    "rules.builtin.doubleSpace.name": "Extra whitespace",
    "rules.builtin.doubleSpace.description": "Multiple consecutive spaces or leading/trailing whitespace.",
    "rules.builtin.repeatedWord.name": "Repeated word",
    "rules.builtin.repeatedWord.description":
      "Same word appears twice in a row, unless the source does the same.",
    "rules.builtin.unpairedSymbols.name": "Unpaired brackets",
    "rules.builtin.unpairedSymbols.description":
      "Mismatched parentheses, brackets, or braces in translation.",
    "rules.builtin.abbreviationMismatch.name": "Abbreviation pass-through",
    "rules.builtin.abbreviationMismatch.description":
      "ALL-CAPS abbreviations from source missing in translation.",

    // ── Shared vocabulary ───────────────────────────────────────────────────
    "rules.severity.major": "Major",
    "rules.severity.minor": "Minor",

    // ── Built-in checks list (RulesSurface) ─────────────────────────────────
    "rules.builtinChecks.heading": "Built-in checks",
    "rules.builtinChecks.violationCount": plural({
      one: "{count} violation",
      other: "{count} violations",
    }),
    "rules.builtinChecks.harmonizeAllTooltip": plural({
      one: "Harmonize all {count} violation for this check",
      other: "Harmonize all {count} violations for this check",
    }),
    "rules.builtinChecks.harmonizeAllButton": "Harmonize all ({count})",
    "rules.builtinChecks.manageNeedsMaintainer": "Only maintainers and owners can change built-in checks",
    "rules.builtinChecks.severitySelectAriaLabel": "{name} severity",
    "rules.builtinChecks.enabledSwitchAriaLabel": "{name} enabled",

    // ── Violation popover (click-to-inspect a blot in the editor) ──────────
    "rules.violationPopover.waivedAt": "Waived {time}",
    "rules.violationPopover.waivedBy": "by {user}",
    "rules.violationPopover.waive": "Waive",
    "rules.violationPopover.unwaive": "Unwaive",
    "rules.violationPopover.reasonPlaceholder": "Reason (optional)",

    // ── Check-file findings drawer (CheckFindingsDrawer, CheckFileButton) ──
    "rules.checkDrawer.title": "File check",
    "rules.checkDrawer.closeAriaLabel": "Close file check",
    "rules.checkDrawer.emptyPrompt": "Run a check to see results for the open file.",
    "rules.checkDrawer.checkedSummary": "Checked {summary} · {time}",
    "rules.checkDrawer.checkedNoIssues": "Checked {summary} — no issues found.",
    "rules.checkDrawer.ruleViolations": "Rule violations ({count})",
    "rules.checkDrawer.termConsistency": "Term consistency ({count})",
    "rules.checkDrawer.otherTermsClean": plural({
      one: "{count} other term checked with no issues.",
      other: "{count} other terms checked with no issues.",
    }),
    "rules.checkDrawer.goToCell": "Go to cell",
    "rules.checkDrawer.commentOnCell": "Comment on this cell",
    "rules.checkDrawer.commentOnCellAriaLabel": "Comment on {label}",
    "rules.checkDrawer.cellCount": plural({
      one: "{count} cell",
      other: "{count} cells",
    }),
    "rules.checkDrawer.matchedDetail": 'matched "{text}"',
    "rules.checkDrawer.scopeRules": plural({ one: "{count} rule", other: "{count} rules" }),
    "rules.checkDrawer.scopeTerms": plural({ one: "{count} term", other: "{count} terms" }),
    "rules.checkDrawer.termHeadline.noneApproved": plural(
      {
        one: "none of {total} occurrence use an approved rendering",
        other: "none of {total} occurrences use an approved rendering",
      },
      "total",
    ),
    "rules.checkDrawer.termHeadline.someApproved": "{consistent} of {total} occurrences use {used}",
    "rules.checkDrawer.termHeadline.someUseSomethingElse": "{usePart}, {flagged} use something else",

    // ── "Check file" toolbar button (the one users see first) ──────────────
    "rules.checkFileButton.label": "Check file",
    "rules.checkFileButton.idleTooltip": "Check the open file against the project's rules and term base",
    "rules.checkFileButton.lastCheckTooltip": "Last check: {issues} · {summary} · {time}",
    "rules.checkFileButton.issueCount": plural({
      one: "{count} issue",
      other: "{count} issues",
    }),

    // ── RulesSurface (the /project/:id/rules view) ──────────────────────────
    "rules.usageSummary": "{fixes} fixes applied · {calls} LLM calls this project",
    "rules.promotion.requested": "Requested ✓",
    "rules.promotion.alreadyRequested": "Already requested",
    "rules.promotion.requestFailed": "Failed — try again",
    "rules.surface.addRuleButton": "Add Rule",
    "rules.surface.createRuleDialog.title": "Create translation rule",
    "rules.surface.createRuleDialog.description": "Create a project translation rule.",
    "rules.surface.createOrgRuleDialog.title": "Create org rule",
    "rules.surface.createOrgRuleDialog.description": "Create an org-scoped translation rule.",
    "rules.surface.usageTooltip": "LLM usage on this project",
    "rules.surface.orgRulesCardTitle": "Org Rules ({count})",
    "rules.surface.addOrgRuleButton": "Add Org Rule",
    // "Read-only" permission badge → common.readOnly (identical text)
    "rules.surface.noOrgRules.title": "No org-level rules yet",
    "rules.surface.noOrgRules.description": "Add one or promote a project rule.",
    // "Org" scope badge → common.org (identical text)
    "rules.surface.editOrgRuleTooltip": "Edit org rule",
    "rules.surface.disableOrgRuleAriaLabel": "Disable org rule: {name}",
    "rules.surface.enableOrgRuleAriaLabel": "Enable org rule: {name}",
    "rules.surface.enabledLabel": "Enabled",
    "rules.surface.pendingRequests": "Pending requests ({count})",
    "rules.surface.requestedBy": "Requested by {requester}",
    "rules.surface.requestedByFallback": "user {userId}",
    "rules.surface.approveRequestTooltip": "Promote this rule to org scope",
    "rules.surface.approveButton": "Approve",
    "rules.surface.dismissRequestTooltip": "Dismiss this request",
    "rules.surface.promoteDialog.title": "Promote rule to org?",
    "rules.surface.promoteDialog.body":
      "A copy of {name} will be added to the org's rule library. The project copy is kept.",
    "rules.surface.promoteDialog.promoting": "Promoting…",
    "rules.surface.projectRulesCardTitle": "Project Rules ({count})",
    "rules.surface.noProjectRules.title": "No project rules yet",
    "rules.surface.noProjectRules.description":
      "Add a rule, import a style guide, or suggest rules from your edits using the buttons above.",
    "rules.surface.noProjectRules.orgRulesNote": "Org rules above also apply to this project.",
    "rules.surface.autofixBadge": "autofix",
    "rules.surface.tryToFixAllTooltip": "Opens the editor with this rule's drawer",
    "rules.surface.tryToFixAllButton": "Try to fix all",
    "rules.surface.promoteToOrgTooltip": "Copy this rule to the org's rule library",
    "rules.surface.promoteToOrgButton": "Promote to org",
    "rules.surface.requestedBadge": "Requested",
    "rules.surface.requestPromotionTooltip": "Ask an org maintainer to promote this rule to org scope",
    "rules.surface.requestingButton": "Requesting…",
    "rules.surface.requestPromotionButton": "Request promotion",
    "rules.surface.disableRuleAriaLabel": "Disable rule: {name}",
    "rules.surface.enableRuleAriaLabel": "Enable rule: {name}",
    "rules.surface.autofixEditor.heading": "Saved autofix (regex)",
    "rules.surface.autofixEditor.replacementPlaceholder": "Replacement",
    "rules.surface.autofixEditor.flagsPlaceholder": "Flags (e.g. gi)",
    "rules.surface.autofixEditor.saveButton": "Save autofix",

    // ── RuleDrawer (editor sidebar — one rule's breaking/passing cells) ────
    "rules.drawer.closeAriaLabel": "Close rule details",
    "rules.drawer.autofixUnavailable": "Autofix is unavailable in this build",
    "rules.drawer.autofixUnavailableAriaLabel": "Autofix unavailable",
    "rules.drawer.amendRuleButton": "Amend rule",
    "rules.drawer.savedAutofix": "Saved autofix: /{pattern}/{flags} → {replacement}",
    "rules.drawer.noSavedFix": "No saved fix yet",
    "rules.drawer.breakingThisRule": "Breaking this rule ({count})",
    "rules.drawer.followingThisRule": "Following this rule ({count})",
    "rules.drawer.noTranslatedCellsYet": "No translated cells yet",

    // ── RuleImportReview (draft rules extracted from a style guide) ────────
    "rules.importReview.draftsExtracted": plural({
      one: "{count} rule draft extracted. Toggle to include or exclude.",
      other: "{count} rule drafts extracted. Toggle to include or exclude.",
    }),
    "rules.importReview.checkLabel.sourceTargetMatch": "match both:",
    "rules.importReview.checkLabel.targetForbids": "target forbids:",
    "rules.importReview.checkLabel.sourceRequiresTargetPrefix": "if source has",
    "rules.importReview.checkLabel.sourceRequiresTargetSuffix": "→ target needs",
    "rules.importReview.fromDoc": "From doc: {evidence}",
    // "Adding…" busy label → common.adding (identical text)
    "rules.importReview.addButton": plural({
      one: "Add {count} rule",
      other: "Add {count} rules",
    }),

    // ── RuleEditor (plain-language rule builder, create + edit) ────────────
    "rules.editor.invalidRegexFallback": "Invalid regex",
    "rules.editor.sentence.forbiddenSource": "On the source, this pattern is forbidden.",
    "rules.editor.sentence.forbiddenTarget": "On the target, this pattern is forbidden.",
    "rules.editor.sentence.required":
      "When the source matches a pattern, the target must contain this pattern.",
    "rules.editor.sentence.match": "This pattern must appear in both source and target.",
    "rules.editor.nameRequired": "Rule name is required",
    "rules.editor.sourceAndTargetPatternRequired": "Source pattern and target pattern are required",
    "rules.editor.patternRequired": "Pattern is required",
    "rules.editor.editRuleHeading": "Edit rule",
    "rules.editor.newRuleHeading": "New rule",
    "rules.editor.nameLabel": "Rule name",
    "rules.editor.namePlaceholder": "e.g. Preserve numbers",
    // "Description (optional)" field label → common.descriptionOptional (identical text)
    "rules.editor.descriptionPlaceholder": "Numbers in source must appear in target",
    // "Mode" field label → common.modeLabel (identical text)
    "rules.editor.mode.forbidden": "Forbidden",
    "rules.editor.mode.required": "Required",
    "rules.editor.mode.match": "Must match",
    "rules.editor.sideLabel": "Side",
    "rules.editor.severityLabel": "Severity",
    "rules.editor.sourcePatternLabel": "Source pattern — when source contains this…",
    "rules.editor.targetPatternLabel": "…target must contain this pattern",
    "rules.editor.patternLabel": "Pattern",
    "rules.editor.textToMatchPlaceholder": "text to match",
    "rules.editor.switchToRegex": "Switch to regex",
    "rules.editor.switchToLiteral": "Switch to literal text",
    "rules.editor.exactTextPlaceholder": "exact text to match",
    "rules.editor.literalTextNote": "Treated as literal text (auto-escaped)",
    "rules.editor.regexNote": "Interpreted as regular expression",
    "rules.editor.livePreviewHeading": "Live preview — current file",
    "rules.editor.noMatches": "No matches in the current file.",
    "rules.editor.wouldBeFlagged": plural(
      { one: "{label} cell would be flagged", other: "{label} cells would be flagged" },
      "count",
    ),
    "rules.editor.srcLabel": "src:",
    "rules.editor.tgtLabel": "tgt:",
    "rules.editor.hideAutofix": "Hide autofix",
    "rules.editor.addAutofix": "Add autofix (optional)",
    "rules.editor.autofixRegexReplaceHeading": "Autofix — regex replace",
    "rules.editor.findPatternLabel": "Find pattern",
    "rules.editor.replaceWithLabel": "Replace with",
    "rules.editor.flagsLabel": "Flags",
    "rules.editor.previewOnSampleLabel": "Preview on sample text",
    "rules.editor.sampleTextPlaceholder": "Type sample text to see before/after…",
    "rules.editor.invalidAutofixPattern": "Invalid autofix pattern",
    // "Save changes" button → common.saveChanges (identical text)
    "rules.editor.createRuleButton": "Create rule",

    // ── RuleImportDialog ("Import from doc" — LLM-extracted rule drafts) ───
    "rules.importDialog.noRulesFound": "No verifiable rules found in the document. Try a style guide or glossary.",
    "rules.importDialog.extractionFailed": "Extraction failed",
    "rules.importDialog.unsupportedFileType": "Unsupported file type. Drop a .txt, .md, .pdf, or .docx file.",
    "rules.importDialog.binaryFileTooLarge": "File too large ({size} MB). Maximum is 2 MB for PDF/DOCX.",
    "rules.importDialog.signInRequiredForBinary": "You must be signed in to import PDF or DOCX files.",
    "rules.importDialog.couldNotParseFile": "Could not parse file.",
    "rules.importDialog.textFileTooLarge": "File too large ({size} KB). Maximum is 200 KB for text files.",
    "rules.importDialog.fileEmpty": "File appears to be empty.",
    "rules.importDialog.extractingRules": "Extracting rules from document…",
    "rules.importDialog.structuring": "Structuring {structured} / {candidates} rules…",
    "rules.importDialog.tooltip": "Import rules from a document",
    "rules.importDialog.tooltipUnconfigured": "Configure LLM in settings first",
    "rules.importDialog.triggerButton": "Import from doc",
    "rules.importDialog.reviewTitle": plural({
      one: "Review {count} extracted rule",
      other: "Review {count} extracted rules",
    }),
    "rules.importDialog.title": "Import rules from document",
    "rules.importDialog.description":
      "Drop a style guide, glossary, or translation guidelines document and the LLM will extract structured rules you can review and accept. Supports plain text and Markdown (max 200 KB) or PDF/DOCX (max 2 MB).",
    "rules.importDialog.dropZoneText": "Drop a {txt}, {md}, {pdf}, or {docx} file here",
    "rules.importDialog.browseButton": "Browse file",
    "rules.importDialog.pasteZoneLabel": "Or paste document text:",
    "rules.importDialog.pastePlaceholder": "Paste text here and it will be processed automatically…",
    "rules.importDialog.configureLlmFirst": "Configure your LLM endpoint in project settings first.",
    "rules.importDialog.candidatesProcessed": "{structured} of {candidates} candidates processed",
    "rules.importDialog.documentTooLarge": "Document is too large ({kb} KB). Please keep it under 200 KB of text.",

    // ── RuleSuggestFromEditsDialog ("Suggest from edits") ──────────────────
    "rules.suggestFromEdits.noPatternsFound":
      "No edit patterns found. Translate some cells in this file to generate suggestions.",
    "rules.suggestFromEdits.noTestablePatterns":
      "The LLM didn't find any testable patterns in your edits. Try validating more diverse translations.",
    "rules.suggestFromEdits.analysisFailed": "Analysis failed",
    "rules.suggestFromEdits.stats.repeated": "{count} repeated",
    "rules.suggestFromEdits.stats.recent": "{count} recent",
    "rules.suggestFromEdits.stats.pairs": "{count} from pairs",
    "rules.suggestFromEdits.stats.human": "{count} human-authored",
    "rules.suggestFromEdits.tooltip": "Mine your edits for rule patterns",
    "rules.suggestFromEdits.tooltipUnconfigured": "Configure LLM in project settings first",
    "rules.suggestFromEdits.triggerButton": "Suggest from edits",
    "rules.suggestFromEdits.reviewTitle": plural({
      one: "Review {count} suggested rule",
      other: "Review {count} suggested rules",
    }),
    "rules.suggestFromEdits.title": "Suggest rules from your edits",
    "rules.suggestFromEdits.description":
      "Analyzes your repeated corrections, recent edits, and human-authored translations to propose testable rules. You'll review each suggestion before anything is saved.",
    "rules.suggestFromEdits.analyzeButton": "Analyze my edits",
    "rules.suggestFromEdits.miningLabel": "Mining edit patterns…",
    "rules.suggestFromEdits.minedPatterns": "Mined patterns: {patterns}",

    // ── completion-service.ts (LLM completion request errors, lib/) ────────
    "rules.completion.failedToFetchModels": "Failed to fetch models: {status} {statusText}",
    "rules.completion.frontierLimitReached": "Frontier AI limit reached: {detail}",
    "rules.completion.outOfCredits": "Out of credits.",
    "rules.completion.completionFailed": "Completion failed: {status} {text}",
    "rules.completion.requestTimedOut": "The AI request timed out. Please try again.",
    "rules.completion.streamError": "Completion stream error",
    "rules.completion.completionAborted": "Completion aborted",
    "rules.completion.signInRequired": "Sign in to use Frontier AI.",
    "rules.completion.noCustomEndpoint": "No custom endpoint configured.",

    // ── autofix.ts (LLM autofix proposal, lib/) — fallbacks only; the LLM's
    // own `reason` text, when present, is LLM-extracted content and is never
    // translated ────────────────────────────────────────────────────────────
    "rules.autofix.noReasonGiven": "No reason given",
    "rules.autofix.couldNotApplyFixes": "Could not apply fixes",

    // ── FixReviewPanel (harmonize / bulk-fix review sheet) ──────────────────
    "rules.fixReview.modeCachedRegex": "Cached regex",
    "rules.fixReview.modeBatchRegex": "Batch regex",
    "rules.fixReview.modePerCellRewrite": "Per-cell rewrite",
    "rules.fixReview.previewsReady": plural({
      one: "{count} preview ready",
      other: "{count} previews ready",
    }),
    "rules.fixReview.cellLabel": "Cell {cellId}",
    "rules.fixReview.irreversibleConfirmPrefix": "This action is irreversible. Type",
    "rules.fixReview.irreversibleConfirmSuffix": "to confirm.",
    "rules.fixReview.confirmInputAriaLabel": "Type the rule name to confirm",
    "rules.fixReview.applyButton": "Apply {count} selected",
  },
  context: {
    _context: {
      description:
        "Translation rules, quality checks and health — the rule list and editor, the file-check pass and its findings drawer, and completion/health readouts. Note the user's OWN rule names and descriptions are content and are never keyed; only the chrome around them is.",
    },
    keys: {
      "rules.builtin.placeholderIntegrity.description": {
        description:
          "Description of the built-in placeholder-integrity check, shown under its name in the built-in checks list.",
        placeholders: {
          name: "Literal example text ('{name}' as in a sample placeholder token) — not an interpolated variable.",
        },
      },
      "rules.checkDrawer.closeAriaLabel": {
        description: "Accessible label for the check-file findings drawer's close button.",
      },
      "rules.infraction.withRuleName": {
        description:
          "Compact single-line rendering of a rule violation where the rule name isn't shown separately (e.g. an agent proposal's lint badge): the rule's own name (never translated) followed by the localized predicate.",
        placeholders: {
          ruleName: "The user's own rule name — verbatim, never translated.",
          message: "The already-localized predicate sentence (see rules.infraction.* reason keys).",
        },
      },
      "rules.infraction.builtin.placeholderIntegrity": {
        description:
          "Placeholder-integrity check finding, shown under a rule/check name that's rendered separately. Names the specific placeholder token(s) (e.g. {name}, %s) missing from the translation, singular or plural depending on how many.",
        placeholders: {
          tokens: "The missing placeholder token(s), comma-joined — raw text, never translated.",
        },
      },
      "rules.builtinChecks.violationCount": {
        description:
          "Badge on a built-in check's row in the checks list, counting how many cells currently violate it.",
        placeholders: { count: "Number of cells currently violating this check." },
      },
      "rules.builtinChecks.harmonizeAllTooltip": {
        description:
          "Tooltip on the 'Harmonize all' button for a built-in check, stating how many violations a harmonization sweep would fix.",
        placeholders: { count: "Number of violations the sweep would fix." },
      },
      "rules.builtinChecks.harmonizeAllButton": {
        description:
          "Button that runs a harmonization sweep fixing every current violation of this built-in check. The count in parentheses does not change grammatical number in English but may need to for other locales.",
        placeholders: {
          count: "Number of violations the sweep would fix.",
        },
      },
      "rules.builtinChecks.severitySelectAriaLabel": {
        description:
          "Accessible label for the severity (Major/Minor) select control on a built-in check's row.",
        placeholders: {
          name: "The built-in check's (translated) display name.",
        },
      },
      "rules.builtinChecks.enabledSwitchAriaLabel": {
        description: "Accessible label for the enabled/disabled switch on a built-in check's row.",
        placeholders: {
          name: "The built-in check's (translated) display name.",
        },
      },
      "rules.violationPopover.waivedAt": {
        description: "Heading in the violation popover's waiver panel, stating when the waiver was recorded.",
        placeholders: { time: "Relative time string, e.g. '5m ago' — see the *Ago keys below." },
      },
      "rules.violationPopover.waivedBy": {
        description: "Attribution line in the violation popover's waiver panel, naming who recorded the waiver.",
        placeholders: { user: "Username or id of the person who waived the rule." },
      },
      "rules.checkDrawer.checkedSummary": {
        description:
          "Header line in the check-file findings drawer, stating what was checked and when the check ran.",
        placeholders: {
          summary: "The 'N cells · N rules · N terms' scope summary (already localized).",
          time: "Localized run time (formatTime).",
        },
      },
      "rules.checkDrawer.checkedNoIssues": {
        description: "Empty-results state in the check-file findings drawer, after a check found nothing.",
        placeholders: { summary: "The 'N cells · N rules · N terms' scope summary (already localized)." },
      },
      "rules.checkDrawer.ruleViolations": {
        description: "Section heading in the check-file findings drawer, counting rule-violation findings.",
        placeholders: { count: "Number of rule-violation findings." },
      },
      "rules.checkDrawer.termConsistency": {
        description: "Section heading in the check-file findings drawer, counting term-consistency findings.",
        placeholders: { count: "Number of flagged term-consistency findings." },
      },
      "rules.checkDrawer.otherTermsClean": {
        description:
          "Footnote under the term-consistency section listing how many checked terms had no issues.",
        placeholders: { count: "Number of clean (unflagged) terms." },
      },
      "rules.checkDrawer.commentOnCellAriaLabel": {
        description: "Accessible label for the per-finding 'comment on this cell' button.",
        placeholders: { label: "The cell's human-facing reference (verse ref or id)." },
      },
      "rules.checkDrawer.cellCount": {
        description: "Count badge on a finding card (rule or term), stating how many cells it flags.",
        placeholders: { count: "Number of cells the finding flags." },
      },
      "rules.checkDrawer.matchedDetail": {
        description:
          "Small caption under a rule-violation cell reference, quoting the exact text that matched. The quoted text itself is raw cell content, never translated.",
        placeholders: { text: "The matched span's raw text — never translated." },
      },
      "rules.checkDrawer.scopeRules": {
        description: "Second segment of the 'what was checked' scope summary.",
        placeholders: { count: "Number of rules the check ran." },
      },
      "rules.checkDrawer.scopeTerms": {
        description: "Third segment of the 'what was checked' scope summary.",
        placeholders: { count: "Number of terms the check ran." },
      },
      "rules.checkDrawer.termHeadline.noneApproved": {
        description:
          "Term-consistency card headline when NO occurrence uses an approved rendering anywhere in scope.",
        placeholders: { total: "Total occurrences of the term in scope." },
      },
      "rules.checkDrawer.termHeadline.someApproved": {
        description:
          "Term-consistency card headline's lead clause when at least one occurrence uses an approved rendering.",
        placeholders: {
          consistent: "Count of occurrences using an approved rendering.",
          total: "Total occurrences of the term in scope.",
          used: "Comma-joined list of the approved rendering(s) used, each with its own count, e.g. '\"Kristo\" (14)'.",
        },
      },
      "rules.checkDrawer.termHeadline.someUseSomethingElse": {
        description:
          "Appended to rules.checkDrawer.termHeadline.someApproved when some occurrences use neither approved nor flagged-consistent renderings.",
        placeholders: {
          usePart: "The already-localized lead clause (someApproved) this appends to.",
          flagged: "Count of occurrences using something other than an approved rendering.",
        },
      },
      "rules.checkFileButton.lastCheckTooltip": {
        description:
          "Tooltip on the toolbar's 'Check file' button after a check has run, summarizing the last run's result.",
        placeholders: {
          issues: "Already-localized issue count, e.g. '3 issues' (see rules.checkFileButton.issueCount).",
          summary: "The 'N cells · N rules · N terms' scope summary (already localized).",
          time: "Localized run time (formatTime).",
        },
      },
      "rules.checkFileButton.issueCount": {
        description: "Issue count embedded in the 'Check file' button's last-run tooltip.",
        placeholders: { count: "Total findings from the last check run." },
      },
      "rules.usageSummary": {
        description: "Small usage footnote at the top of the Rules surface, above the built-in checks list.",
        placeholders: {
          fixes: "How many autofixes have been applied on this project.",
          calls: "How many LLM calls the project has made (rule suggestion, harmonization, etc).",
        },
      },
      "rules.surface.orgRulesCardTitle": {
        description: "Card heading for the org-scoped rules list.",
        placeholders: { count: "Number of org rules." },
      },
      "rules.surface.disableOrgRuleAriaLabel": {
        description: "Accessible label for the enable/disable switch on an org rule row, when currently enabled.",
        placeholders: { name: "The org rule's own name — content, never translated." },
      },
      "rules.surface.enableOrgRuleAriaLabel": {
        description: "Accessible label for the enable/disable switch on an org rule row, when currently disabled.",
        placeholders: { name: "The org rule's own name — content, never translated." },
      },
      "rules.surface.pendingRequests": {
        description: "Heading above the list of pending org-promotion requests (maintainer view).",
        placeholders: { count: "Number of pending requests." },
      },
      "rules.surface.requestedBy": {
        description: "Attribution line on a pending org-promotion request, naming who requested it.",
        placeholders: { requester: "The requester's display name, or the requestedByFallback string." },
      },
      "rules.surface.requestedByFallback": {
        description: "Fallback attribution when a promotion request has no stored display name.",
        placeholders: { userId: "The requesting user's numeric id." },
      },
      "rules.surface.promoteDialog.body": {
        description:
          "Confirmation body in the 'Promote rule to org?' dialog, naming the rule about to be copied to the org library.",
        placeholders: { name: "The rule's own name, rendered bold via RichMessage — content, never translated." },
      },
      "rules.surface.projectRulesCardTitle": {
        description: "Card heading for the project-scoped (user-authored) rules list.",
        placeholders: { count: "Number of project rules." },
      },
      "rules.surface.disableRuleAriaLabel": {
        description: "Accessible label for the enable/disable switch on a project rule row, when currently enabled.",
        placeholders: { name: "The rule's own name — content, never translated." },
      },
      "rules.surface.enableRuleAriaLabel": {
        description: "Accessible label for the enable/disable switch on a project rule row, when currently disabled.",
        placeholders: { name: "The rule's own name — content, never translated." },
      },
      "rules.drawer.closeAriaLabel": {
        description: "Accessible label for the rule drawer's close button.",
      },
      "rules.drawer.autofixUnavailableAriaLabel": {
        description: "Accessible label for a disabled per-cell autofix button in the rule drawer.",
      },
      "rules.drawer.savedAutofix": {
        description:
          "Footer strip in the rule drawer, showing the rule's saved autofix as a literal /pattern/flags → replacement expression.",
        placeholders: {
          pattern: "The saved regex pattern — content, never translated.",
          flags: "The saved regex flags — content, never translated.",
          replacement: "The saved replacement text — content, never translated.",
        },
      },
      "rules.drawer.breakingThisRule": {
        description: "Section heading in the rule drawer, counting cells that currently break this rule.",
        placeholders: { count: "Number of cells breaking the rule." },
      },
      "rules.drawer.followingThisRule": {
        description:
          "Section heading in the rule drawer, counting cells that pass this rule (sample of up to 10, so may show a trailing '+').",
        placeholders: { count: "Number of passing cells shown, e.g. '10+' when the sample is capped." },
      },
      "rules.importReview.fromDoc": {
        description:
          "Small italic caption on a draft rule card, showing the source-document evidence it was extracted from.",
        placeholders: { evidence: "Quoted excerpt from the source document — content, never translated." },
      },
      "rules.importReview.draftsExtracted": {
        description: "Intro line above the list of draft rules extracted from an imported style guide.",
        placeholders: { count: "Number of draft rules extracted." },
      },
      "rules.importReview.addButton": {
        description: "Primary button committing the accepted draft rules from the import-review screen.",
        placeholders: { count: "Number of accepted draft rules to add." },
      },
      "rules.importDialog.binaryFileTooLarge": {
        description: "Error shown when a dropped PDF/DOCX exceeds the 2 MB import cap.",
        placeholders: { size: "The file's size in MB, one decimal place." },
      },
      "rules.importDialog.textFileTooLarge": {
        description: "Error shown when a dropped .txt/.md file exceeds the 200 KB import cap.",
        placeholders: { size: "The file's size in KB, whole number." },
      },
      "rules.importDialog.structuring": {
        description:
          "Progress label during the import dialog's second LLM pass, converting raw candidates into structured rules.",
        placeholders: {
          structured: "How many candidates have been structured so far.",
          candidates: "Total candidates from the first extraction pass.",
        },
      },
      "rules.importDialog.reviewTitle": {
        description: "Dialog title once extraction finishes and the drafts are ready for review.",
        placeholders: { count: "Number of rule drafts extracted." },
      },
      "rules.importDialog.dropZoneText": {
        description:
          "Instruction in the import dialog's drop zone, naming the accepted file extensions (each rendered bold via RichMessage).",
        placeholders: {
          txt: "The literal '.txt' extension, rendered bold.",
          md: "The literal '.md' extension, rendered bold.",
          pdf: "The literal '.pdf' extension, rendered bold.",
          docx: "The literal '.docx' extension, rendered bold.",
        },
      },
      "rules.importDialog.candidatesProcessed": {
        description: "Sub-progress line during structuring, under the main progress label.",
        placeholders: {
          structured: "How many candidates have been structured so far.",
          candidates: "Total candidates from the first extraction pass.",
        },
      },
      "rules.importDialog.documentTooLarge": {
        description:
          "Error from checkInputSize() (rule-extractor.ts) when a pasted/loaded document exceeds the 200 KB extraction limit.",
        placeholders: { kb: "The document's size in KB, whole number." },
      },
      "rules.suggestFromEdits.stats.repeated": {
        description:
          "One segment of the comma-joined mining-stats summary ('N repeated, N recent, …') after analyzing edits.",
        placeholders: { count: "Number of repeated-correction candidates mined." },
      },
      "rules.suggestFromEdits.stats.recent": {
        description: "Mining-stats segment counting recently-edited-cell candidates.",
        placeholders: { count: "Number of recent-edit candidates mined." },
      },
      "rules.suggestFromEdits.stats.pairs": {
        description: "Mining-stats segment counting candidates from validated source/target pairs.",
        placeholders: { count: "Number of validated-pair candidates mined." },
      },
      "rules.suggestFromEdits.stats.human": {
        description: "Mining-stats segment counting human-authored (non-AI-drafted) candidates.",
        placeholders: { count: "Number of human-authored candidates mined." },
      },
      "rules.suggestFromEdits.reviewTitle": {
        description: "Dialog title once edit-mining + LLM suggestion finishes and drafts are ready for review.",
        placeholders: { count: "Number of suggested rule drafts." },
      },
      "rules.suggestFromEdits.minedPatterns": {
        description: "Summary line above the review list, showing the mining-stats breakdown.",
        placeholders: { patterns: "Already-localized, comma-joined stats segments (see rules.suggestFromEdits.stats.*)." },
      },
      "rules.completion.failedToFetchModels": {
        description: "Thrown error when the model-list fetch for a custom OpenAI-compatible endpoint fails.",
        placeholders: {
          status: "HTTP status code — content, never translated.",
          statusText: "HTTP status text — content, never translated.",
        },
      },
      "rules.completion.frontierLimitReached": {
        description:
          "Thrown error when a Frontier completion request 402s (subscription/credits exhausted).",
        placeholders: { detail: "Server-provided detail text, or rules.completion.outOfCredits as a fallback." },
      },
      "rules.completion.completionFailed": {
        description: "Generic thrown error when a completion request fails with a non-ok, non-402 status.",
        placeholders: {
          status: "HTTP status code — content, never translated.",
          text: "Raw response body text — content, never translated.",
        },
      },
      "rules.fixReview.previewsReady": {
        description: "Count of ready-to-apply fix previews in the harmonize/bulk-fix review sheet.",
        placeholders: { count: "Number of fix previews ready to apply." },
      },
      "rules.fixReview.confirmInputAriaLabel": {
        description: "Accessible label for the typed-confirmation input gating a bulk harmonize Apply.",
      },
      "rules.fixReview.cellLabel": {
        description: "Compact label above each fix preview row, identifying which cell it applies to.",
        placeholders: { cellId: "The cell's id — content, never translated." },
      },
      "rules.fixReview.applyButton": {
        description: "Primary button applying the selected fix previews.",
        placeholders: { count: "Number of previews currently selected to apply." },
      },
      "rules.editor.wouldBeFlagged": {
        description:
          "Live-preview result in the rule editor: how many cells in the current file the draft rule would flag. " +
          "Plural form is selected from the real count (a separate `count` var, not rendered in the string) " +
          "rather than from `label`, which may read '3+' when the preview sample is capped.",
        placeholders: {
          label: "Display label for the count, e.g. '2' or '3+' (preview samples cap at 3).",
        },
      },
    },
  },
  surfaces: [],
})
