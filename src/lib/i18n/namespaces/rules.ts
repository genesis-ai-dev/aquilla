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
    },
  },
  surfaces: [],
})
