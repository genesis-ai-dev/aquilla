import { defineNamespace } from "./types"

/**
 * search — AQU-511 wave 2.
 *
 * Covers the search dock panel (SearchDockPanel), the full-screen parallel-
 * passages / find-and-replace dialog (ParallelPassagesPanel), the "expand all
 * results" main-area view (SearchResultsView), and the translation-memory
 * examples popover (ExamplePanel).
 *
 * Two strings are deliberately NOT here:
 * - The bare word "Search" as a mode label/aria-label reuses `nav.search`
 *   (nav already carries it) rather than a `search.search` twin.
 * - "Loading…" in the Bible-resources reader reuses `common.loading`
 *   verbatim rather than a new key.
 *
 * Pluralization: `translate()` has no plural-rules engine — it only does
 * `{name}` substitution. Every English string here whose grammatical number
 * actually changes with the count (e.g. "1 result" vs "2 results") is split
 * into an explicit `...One` / `...Other` key pair, chosen by the component at
 * call time. Strings where the noun doesn't inflect ("Replace {count}",
 * "{count} more — …") stay a single key.
 */
export const search = defineNamespace({
  keys: {
    // Mode toggle (dock panel + full-panel mode tabs)
    "search.mode.searchTooltip": "Search text",
    "search.mode.replace": "Replace",
    "search.mode.replaceTooltip": "Find & Replace",
    "search.mode.bible": "Bible",
    "search.mode.bibleTooltip": "Bible resources",
    "search.mode.passages": "Passages",

    // Scope toggle (dock panel + full panel)
    "search.scope.label": "Search scope",
    "search.scope.file": "File",
    "search.scope.project": "Project",

    "search.openFullPanel": "Open full search panel",

    // Search input placeholders shared verbatim between dock and dialog
    "search.placeholderProject": "Search project…",
    "search.placeholderFile": "Search {fileName}…",

    "search.searching": "Searching…",
    "search.noResults": "No results",

    // Dock panel — idle / result states
    "search.dock.typeToSearchFile": "Type to search this file",
    "search.dock.typeToSearchProject": "Type to search the project",
    "search.resultCountOne": "{count} result",
    "search.resultCountOther": "{count} results",
    "search.dock.expandAllTooltip": "Expand all results in main area",
    "search.dock.expandAllAriaLabel": "Expand all results",
    "search.dock.expandAllLabel": "Expand all",
    "search.dock.moreResults": "{count} more — open full panel for all results",
    "search.dock.replaceHint": "Find & Replace with diff preview lives in the full panel.",
    "search.dock.openReplace": "Open Find & Replace",

    // Dock panel — Bible resources (Aquifer) mode
    "search.bible.backToResults": "Back to results",
    "search.bible.openExternal": "Open on bibletranslation.org",
    "search.bible.truncated": "Truncated — open the full page on bibletranslation.org.",
    "search.bible.notesFor": "Notes for {ref}",
    "search.bible.searchPlaceholder": "Search Bible resources…",
    "search.bible.noResults": "No resources found",
    "search.bible.idleHint":
      "Search bibletranslation.org for people, places, terms, and translation notes.",

    // Replace (shared by the dock's "open full panel" hint and the dialog's
    // Replace mode — the actual replace UI only exists in the dialog)
    "search.replace.includeCellAriaLabel": "Include cell {cellId} in replace",
    "search.replace.cellLocation": "{fileId} · cell {cellId}",
    "search.replace.matchCount": "{count} replacements in this cell",
    "search.replace.placeholder": "Replacement text…",
    "search.replace.clearsValidation":
      "Replacing text clears validation — it must be re-reviewed.",
    "search.replace.skippedNoticeOne": "{count} match skipped — spans HTML tag boundary.",
    "search.replace.skippedNoticeOther": "{count} matches skipped — spans HTML tag boundary.",
    "search.replace.appliedResultOne": "Replaced {count} cell.",
    "search.replace.appliedResultOther": "Replaced {count} cells.",
    "search.replace.appliedResultWithSkippedOne":
      "Replaced {count} cell ({skipped} skipped — HTML boundary).",
    "search.replace.appliedResultWithSkippedOther":
      "Replaced {count} cells ({skipped} skipped — HTML boundary).",
    "search.replace.affectedCountOne": "{count} cell affected",
    "search.replace.affectedCountOther": "{count} cells affected",
    "search.replace.selectAll": "Select all",
    "search.replace.selectNone": "Select none",
    "search.replace.cellListAriaLabel": "Cells to replace",
    "search.replace.readOnlyTooltip": "Replace requires contributor access on these files",
    "search.replace.notWiredTooltip": "Replace is not yet wired",
    "search.replace.applying": "Applying…",
    "search.replace.applyButtonCount": "Replace {count}",
    "search.replace.applyButtonAll": "Replace All",

    // Result row column badge (aria-hidden decorative label on a search hit)
    "search.result.columnSource": "source",
    "search.result.columnTarget": "target",

    // Full-panel dialog chrome
    "search.dialog.titlePassages": "Parallel passages",
    "search.dialog.titleReplace": "Search and Replace",
    "search.dialog.scopeFile": "File: {fileName}",
    "search.dialog.scopeCurrentFile": "Current file",
    "search.dialog.scopeEntireProject": "Entire project",
    "search.dialog.placeholderPassages": "Search parallel passages across all projects…",
    "search.dialog.placeholderScoped": "Search {scope}…",
    "search.dialog.placeholderReplaceProject": "Find in project…",
    "search.dialog.placeholderReplaceScoped": "Find in {scope}…",
    "search.dialog.controlsAriaLabel": "Panel controls",
    "search.dialog.modeLabel": "Search mode",
    "search.dialog.contentSideLabel": "Content side",
    "search.side.both": "Both",
    "search.side.source": "Source",
    "search.side.target": "Target",
    "search.dialog.openFileHint": "Open a file to enable file-scoped search.",
    "search.dialog.replaceSectionHeading": "Replace (target cells only)",
    "search.dialog.idlePassages":
      "Type to find parallel passages — results show source and target side by side.",
    "search.dialog.idleReplace": "Type a search term above to find target cells for replacement.",
    "search.dialog.idleSearchFile": "Type to search across the open file.",
    "search.dialog.idleSearchProject": "Type to search across the project.",
    "search.dialog.noResultsFor": "No results for",

    // Expanded "results as editor" view
    "search.expanded.header": "Search Results",
    "search.expanded.forQueryPrefix": "for",
    "search.expanded.countsJoiner": "in",
    "search.expanded.fileCountOne": "{count} file",
    "search.expanded.fileCountOther": "{count} files",
    "search.expanded.close": "Close search results",

    // Translation-memory examples popover
    "search.examples.countOne": "{count} example",
    "search.examples.countOther": "{count} examples",
    "search.examples.popoverAriaLabel": "Translation examples",
  },
  context: {
    _context: {
      description:
        "Search across a project: the always-visible dock panel, the full-screen " +
        "search/parallel-passages/find-and-replace dialog it can expand into, the " +
        "'expand all results' view that opens in the main editor area, and the " +
        "translation-memory examples popover shown beside a cell. Most controls sit " +
        "in a narrow dock or a modal toolbar, competing for space with icons and tabs.",
      screenshot: "search",
    },
    keys: {
      "search.mode.searchTooltip": {
        description: "Tooltip on the dock's Search mode toggle. A short noun phrase.",
      },
      "search.mode.replace": {
        description:
          "Short visible label on the Replace mode toggle/tab, in both the dock panel " +
          "and the full dialog's mode tabs. Sits beside an icon; keep it to one word.",
      },
      "search.mode.replaceTooltip": {
        description:
          "Tooltip AND accessible name (aria-label) of the dock's Replace mode toggle. " +
          "Longer than the visible 'Replace' label because it also functions as the " +
          "screen-reader announcement.",
      },
      "search.mode.bible": {
        description:
          "Short visible label on the Bible-resources mode toggle. Sits beside an icon; " +
          "one word.",
      },
      "search.mode.bibleTooltip": {
        description:
          "Tooltip AND accessible name (aria-label) of the dock's Bible-resources mode " +
          "toggle, which searches bibletranslation.org reference material.",
      },
      "search.mode.passages": {
        description:
          "Mode-tab label in the full dialog for parallel-passage search (cross-project " +
          "verse matching, not this project's cells).",
      },
      "search.scope.label": {
        description:
          "Accessible name (aria-label) of the File/Project scope toggle, read by screen " +
          "readers before the two tab options.",
      },
      "search.scope.file": {
        description:
          "Tab option that scopes the search to the currently open file. Falls back to " +
          "this generic word when no file is open (disabled) or the file's own name is " +
          "shown instead when one is.",
      },
      "search.scope.project": {
        description: "Tab option that scopes the search to every file in the project.",
      },
      "search.openFullPanel": {
        description:
          "Tooltip AND aria-label on the icon button that expands the dock panel into " +
          "the full-screen search dialog.",
      },
      "search.placeholderProject": {
        description:
          "Input placeholder shown in both the dock panel and the full dialog's search " +
          "box when the scope is the whole project (not a single file).",
      },
      "search.placeholderFile": {
        description:
          "Input placeholder shown in the dock panel's search box when scoped to a " +
          "single file.",
        placeholders: {
          fileName: "The open file's display name, e.g. 'Genesis.sfm'. Not translated.",
        },
      },
      "search.searching": {
        description:
          "Transient status text shown in place of results while a search request is " +
          "in flight, in both the dock panel and the full dialog.",
      },
      "search.noResults": {
        description:
          "Empty-state message shown when a search returned zero hits — used in the " +
          "dock panel's result list and the expanded main-area results view.",
      },
      "search.dock.typeToSearchFile": {
        description:
          "Dock panel idle-state hint, shown before the user has typed anything, when " +
          "scope is set to the current file.",
      },
      "search.dock.typeToSearchProject": {
        description:
          "Dock panel idle-state hint, shown before the user has typed anything, when " +
          "scope is set to the whole project.",
      },
      "search.resultCountOne": {
        description:
          "Result-count label for exactly one hit. Shown in the dock panel's result " +
          "group and the full dialog's results footer.",
        placeholders: { count: "Always 1 — kept as a placeholder so wording stays parallel with the Other form." },
      },
      "search.resultCountOther": {
        description:
          "Result-count label for zero or two-or-more hits. Shown in the dock panel's " +
          "result group and the full dialog's results footer.",
        placeholders: { count: "Number of matching hits." },
      },
      "search.dock.expandAllTooltip": {
        description:
          "Tooltip on the dock's 'expand all results' icon button, which opens every " +
          "current hit in the main editor area as a browsable list.",
      },
      "search.dock.expandAllAriaLabel": {
        description: "Accessible name (aria-label) of the same expand-all icon button.",
      },
      "search.dock.expandAllLabel": {
        description: "Visible text label next to the expand-all icon.",
      },
      "search.dock.moreResults": {
        description:
          "Shown below a truncated result list (only the first 50 hits render inline) " +
          "telling the user how many more exist and that the full dialog shows all of them.",
        placeholders: { count: "How many additional hits beyond the 50 shown are not listed." },
      },
      "search.dock.replaceHint": {
        description:
          "Explanatory note in the dock's Replace mode, telling the user the diff-preview " +
          "replace workflow lives in the full dialog, not the dock itself.",
      },
      "search.dock.openReplace": {
        description:
          "Button in the dock's Replace mode that opens the full Find & Replace dialog.",
      },
      "search.bible.backToResults": {
        description:
          "Accessible name (aria-label) of the back-arrow icon button that returns from " +
          "a Bible-resources reader page to the resource search results.",
      },
      "search.bible.openExternal": {
        description:
          "Tooltip AND aria-label on the external-link icon that opens the current " +
          "resource page on the bibletranslation.org website in a new tab.",
      },
      "search.bible.truncated": {
        description:
          "Notice shown under a Bible-resources reader page when its text was cut off " +
          "for length, pointing the user to the full page on the source site.",
      },
      "search.bible.notesFor": {
        description:
          "Quick-lookup button offered when a cell is focused, opening translation notes " +
          "for that verse.",
        placeholders: {
          ref: "Canonical Scripture reference of the focused cell, e.g. 'RUT 1:8'. Not translated.",
        },
      },
      "search.bible.searchPlaceholder": {
        description:
          "Placeholder AND aria-label on the Bible-resources search box (people, places, " +
          "terms, translation notes from bibletranslation.org).",
      },
      "search.bible.noResults": {
        description:
          "Empty-state message when a Bible-resources search returns no hits. Distinct " +
          "from the generic 'search.noResults' because this searches an external " +
          "reference site, not the project's own cells.",
      },
      "search.bible.idleHint": {
        description:
          "Idle-state hint in the Bible-resources search box before the user types " +
          "anything, describing what kinds of things can be found there.",
      },
      "search.replace.includeCellAriaLabel": {
        description:
          "Accessible name (aria-label) of the checkbox beside a replace-diff preview " +
          "row, letting a screen-reader user identify which cell it toggles.",
        placeholders: { cellId: "Internal id of the cell row. Not translated." },
      },
      "search.replace.cellLocation": {
        description:
          "Small location label above a replace-diff preview row, identifying which " +
          "file and cell the before/after text belongs to. 'cell' is the only " +
          "translatable word — it names the row/unit being edited.",
        placeholders: {
          fileId: "Internal id of the file the cell belongs to. Not translated.",
          cellId: "Internal id of the cell. Not translated.",
        },
      },
      "search.replace.matchCount": {
        description:
          "Shown under a diff preview row only when a single cell contains more than " +
          "one match for the find term, so 'replacements' is always plural here — the " +
          "row is hidden entirely for a single match.",
        placeholders: { count: "How many times the find term occurs in this one cell." },
      },
      "search.replace.placeholder": {
        description:
          "Placeholder AND aria-label on the 'replace with' text input in the full " +
          "dialog's Replace mode.",
      },
      "search.replace.clearsValidation": {
        description:
          "Honest-copy note under the replace input explaining that applying a replace " +
          "advances the cell's edit chain, so any prior validation is dropped and the " +
          "cell must be re-reviewed (AQU-286 — there is no 'retain validations' option).",
      },
      "search.replace.skippedNoticeOne": {
        description:
          "Warning shown when exactly one match could not be replaced because it spans " +
          "an HTML tag boundary (e.g. matching text that straddles '</b>').",
        placeholders: { count: "Always 1." },
      },
      "search.replace.skippedNoticeOther": {
        description:
          "Warning shown when zero or several matches could not be replaced because " +
          "they span an HTML tag boundary.",
        placeholders: { count: "How many matches were skipped." },
      },
      "search.replace.appliedResultOne": {
        description:
          "Success message after applying a replace that changed exactly one cell and " +
          "skipped none.",
        placeholders: { count: "Always 1." },
      },
      "search.replace.appliedResultOther": {
        description:
          "Success message after applying a replace that changed zero or several cells " +
          "and skipped none.",
        placeholders: { count: "How many cells were changed." },
      },
      "search.replace.appliedResultWithSkippedOne": {
        description:
          "Success message after applying a replace that changed exactly one cell and " +
          "also skipped some HTML-boundary matches.",
        placeholders: {
          count: "Always 1.",
          skipped: "How many matches were skipped for spanning an HTML tag boundary.",
        },
      },
      "search.replace.appliedResultWithSkippedOther": {
        description:
          "Success message after applying a replace that changed zero or several cells " +
          "and also skipped some HTML-boundary matches.",
        placeholders: {
          count: "How many cells were changed.",
          skipped: "How many matches were skipped for spanning an HTML tag boundary.",
        },
      },
      "search.replace.affectedCountOne": {
        description:
          "Live count above the diff preview list, for exactly one cell matching the " +
          "current find/replace terms.",
        placeholders: { count: "Always 1." },
      },
      "search.replace.affectedCountOther": {
        description:
          "Live count above the diff preview list, for zero or several cells matching " +
          "the current find/replace terms.",
        placeholders: { count: "How many cells the current find term matches." },
      },
      "search.replace.selectAll": {
        description:
          "Link-styled button above the diff preview list that selects every row for " +
          "replacement.",
      },
      "search.replace.selectNone": {
        description:
          "Link-styled button above the diff preview list that deselects every row.",
      },
      "search.replace.cellListAriaLabel": {
        description:
          "Accessible name (aria-label) of the diff-preview list region, read once by a " +
          "screen reader before its rows.",
      },
      "search.replace.readOnlyTooltip": {
        description:
          "Tooltip on the disabled Replace button explaining WHY it's disabled, when the " +
          "user lacks contributor access to the files involved.",
      },
      "search.replace.notWiredTooltip": {
        description:
          "Tooltip on the disabled Replace button explaining WHY it's disabled, when the " +
          "host screen hasn't wired a handler for it (developer-facing edge case, but " +
          "still user-visible text if it somehow renders).",
      },
      "search.replace.applying": {
        description: "Replace button label while the replace operation is in flight.",
      },
      "search.replace.applyButtonCount": {
        description:
          "Replace button label once at least one diff row is selected. 'Replace' does " +
          "not change grammatical number with the count, so this is a single key.",
        placeholders: { count: "How many cells are selected to be replaced." },
      },
      "search.replace.applyButtonAll": {
        description:
          "Replace button label before any row is individually selected/deselected — " +
          "implies 'replace everything currently matched'.",
      },
      "search.result.columnSource": {
        description:
          "Tiny decorative badge (aria-hidden, not read by screen readers) beside a " +
          "search hit marking it as source-language text, as opposed to target. " +
          "Deliberately lowercase in the UI. Different key from 'search.side.source' " +
          "because that one is a visible, capitalized filter-tab label — same underlying " +
          "concept (source vs. target text) but a different visual role and casing.",
      },
      "search.result.columnTarget": {
        description:
          "Tiny decorative badge (aria-hidden) beside a search hit marking it as " +
          "target-language (translated) text. See 'search.result.columnSource' for why " +
          "this isn't merged with 'search.side.target'.",
      },
      "search.dialog.titlePassages": {
        description:
          "Full dialog's title AND footer label when in parallel-passages mode " +
          "(cross-project verse matching).",
      },
      "search.dialog.titleReplace": {
        description: "Full dialog's title when in Replace mode.",
      },
      "search.dialog.scopeFile": {
        description:
          "Human-readable scope description shown in the dialog title/footer when scoped " +
          "to a specific open file.",
        placeholders: { fileName: "The open file's display name. Not translated." },
      },
      "search.dialog.scopeCurrentFile": {
        description:
          "Fallback scope description used when scope is 'file' but no file name is " +
          "available yet.",
      },
      "search.dialog.scopeEntireProject": {
        description: "Scope description shown when searching the whole project.",
      },
      "search.dialog.placeholderPassages": {
        description:
          "Search-box placeholder in the full dialog's parallel-passages mode, which " +
          "searches across every project the user has access to, not just this one.",
      },
      "search.dialog.placeholderScoped": {
        description:
          "Search-box placeholder in the full dialog's plain Search mode when scoped to " +
          "a file. The {scope} value is already-localized display text (e.g. the result " +
          "of resolving 'search.dialog.scopeFile' or 'search.dialog.scopeCurrentFile' and " +
          "lowercasing it), not raw data — a known composition limitation: the lowercase " +
          "operation is a no-op in scripts without case, but the sentence structure is " +
          "fixed English word order and cannot be reworded per locale.",
        placeholders: { scope: "Already-localized, lowercased description of the search scope." },
      },
      "search.dialog.placeholderReplaceProject": {
        description:
          "Find-box placeholder in the full dialog's Replace mode when scope is the " +
          "whole project.",
      },
      "search.dialog.placeholderReplaceScoped": {
        description:
          "Find-box placeholder in the full dialog's Replace mode when scoped to a file. " +
          "Same composition caveat as 'search.dialog.placeholderScoped'.",
        placeholders: { scope: "Already-localized, lowercased description of the search scope." },
      },
      "search.dialog.controlsAriaLabel": {
        description:
          "Accessible name (aria-label) of the row of scope/mode/side toggles at the top " +
          "of the full dialog.",
      },
      "search.dialog.modeLabel": {
        description:
          "Accessible name (aria-label) of the Search/Passages/Replace mode tab group in " +
          "the full dialog.",
      },
      "search.dialog.contentSideLabel": {
        description:
          "Accessible name (aria-label) of the Both/Source/Target toggle in the full " +
          "dialog, hidden while in Replace mode (which is always target-only).",
      },
      "search.side.both": {
        description: "Tab option: search both source and target text.",
      },
      "search.side.source": {
        description:
          "Tab option: search only source-language text. Also reused as the section " +
          "heading over the source line in the translation-examples popover — same " +
          "meaning (source-language text) in both places.",
      },
      "search.side.target": {
        description:
          "Tab option: search only target-language (translated) text. Also reused as the " +
          "section heading over the target line in the translation-examples popover.",
      },
      "search.dialog.openFileHint": {
        description:
          "Note shown under the search box when scope is 'file' but no file is open, " +
          "explaining why the File scope tab is disabled.",
      },
      "search.dialog.replaceSectionHeading": {
        description:
          "Small heading introducing the replace input/diff-preview block in the full " +
          "dialog's Replace mode, clarifying that replace only ever touches target text.",
      },
      "search.dialog.idlePassages": {
        description:
          "Idle-state hint in the full dialog before any query is typed, when in " +
          "parallel-passages mode.",
      },
      "search.dialog.idleReplace": {
        description:
          "Idle-state hint in the full dialog before any query is typed, when in " +
          "Replace mode.",
      },
      "search.dialog.idleSearchFile": {
        description:
          "Idle-state hint in the full dialog before any query is typed, in plain Search " +
          "mode scoped to the currently open file.",
      },
      "search.dialog.idleSearchProject": {
        description:
          "Idle-state hint in the full dialog before any query is typed, in plain Search " +
          "mode scoped to the whole project.",
      },
      "search.dialog.noResultsFor": {
        description:
          "Lead-in phrase for the empty-results message in the full dialog. The UI " +
          "appends the literal search term afterward, wrapped in curly quotes and bold " +
          "(kept as fixed markup, not part of this string) and a trailing period.",
      },
      "search.expanded.header": {
        description:
          "Heading of the 'expand all results' view that opens in the main editor area, " +
          "listing every current search hit grouped by file.",
      },
      "search.expanded.forQueryPrefix": {
        description:
          "Lead-in word shown next to the header when a query is active, followed by the " +
          "literal search term in curly quotes (fixed markup, not part of this string).",
      },
      "search.expanded.countsJoiner": {
        description:
          "Preposition joining the result count and file count in the results-view " +
          "header summary ('2 results {in} 1 file'). Composing two independently " +
          "pluralized phrases around a fixed joiner word is a known limitation — word " +
          "order may not translate cleanly into every target language; flag to the " +
          "review panel if a translation reads awkwardly here.",
      },
      "search.expanded.fileCountOne": {
        description:
          "Part of the results-view header summary, for the case where hits span exactly " +
          "one file. Composed with 'search.resultCountOne'/'search.resultCountOther' and " +
          "a fixed 'in' — see that pair's note on the composition limitation.",
        placeholders: { count: "Always 1." },
      },
      "search.expanded.fileCountOther": {
        description:
          "Part of the results-view header summary, for the case where hits span zero " +
          "or several files.",
        placeholders: { count: "How many distinct files the hits are spread across." },
      },
      "search.expanded.close": {
        description:
          "Accessible name (aria-label) of the close (X) button on the expanded results " +
          "view.",
      },
      "search.examples.countOne": {
        description:
          "Trigger button in the translation-memory examples popover, for exactly one " +
          "example pair.",
        placeholders: { count: "Always 1." },
      },
      "search.examples.countOther": {
        description:
          "Trigger button in the translation-memory examples popover, for zero or " +
          "several example pairs.",
        placeholders: { count: "How many similar source/target example pairs were found." },
      },
      "search.examples.popoverAriaLabel": {
        description:
          "Accessible name (aria-label) of the examples popover content region, read " +
          "once by a screen reader before its example pairs.",
      },
    },
  },
  surfaces: [
    {
      id: "search",
      title: "Search dock panel",
      route: "/project/:projectId",
      notes:
        "Left-dock search panel open with a query entered so results, the mode " +
        "switcher, and the scope toggle are all visible at once.",
    },
  ],
})
