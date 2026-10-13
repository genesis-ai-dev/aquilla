// Aquilla Tools builder — the judgment sections of the system prompt (AQU-1793):
// the UI quality bar, how to pick mounts, and what Aquilla's data actually
// contains (so a plan never promises data the bridge does not expose). Kept
// apart from build-prompt.ts, which is the API reference.

/** The UI bar every extension is reviewed against (the self-review uses the same list). */
export const UI_CHECKS = [
  "no-duplicate-header: no in-frame title, tool name, description or intro/help paragraph — the host header already shows the name, description and placement",
  "honest-copy: minimal UI copy, and no text that contradicts the behaviour (e.g. 'saves automatically' next to a Save/Done button)",
  "loading-skeleton: a loading skeleton is in the static HTML, visible before any await, replaced once data arrives",
  "sdk-components: cells, translations and validation use the aq SDK components (aq.CellList / aq.CellRow / aq.SourceText / aq.TargetEditor / aq.ValidateButton) and aq.ui for controls; hand-rolled UI only where no component fits",
  "accessible: every control has a visible label or aria-label; icon-only buttons have aria-label",
  "empty-and-error states: no files, no cells, empty translations and bridge errors each render something sensible",
  "mount-fit: the declared mounts match what the request implies",
] as const

export const TOOLS_DESIGN_PROMPT = `## Design rules (every build is reviewed against these)
- The host already shows the extension's name, description and placement above the frame. Do NOT draw
  your own title, tool name, tagline, description, "how to use" text or intro paragraph. Start with the UI.
  In page/panel mounts call aq.ui.Page / aq.ui.Panel WITHOUT a title (titles are only for sections inside).
- Minimal copy: labels of one to three words, no explanatory paragraphs. Never write copy the UI then
  contradicts (if edits autosave, show no Save/Done button and don't explain saving at all).
- Loading: put a skeleton in the STATIC HTML (a few placeholder rows: blocks with background var(--muted),
  rounded, ~12px tall) so the frame is never blank; aq.mount replaces it. While data loads after that, show
  aq.ui.Spinner or the same skeleton, never an empty area. Big books load in pages: show the first page at once.
- Use the SDK: aq.CellList / aq.CellRow / aq.SourceText / aq.TargetEditor / aq.ValidateButton for anything
  that shows or edits cells (they bring validation, locks, live typing, the app's look), and aq.ui for
  buttons, tabs, inputs, badges, empty states. Hand-roll UI (with the host CSS variables) only when no
  component fits. Never restyle the SDK components.
- Every control has a label or aria-label. Empty and error states render inside the UI, never throw.
- Calm, dense, modern: one font size for body text, muted secondary text, 4/8px spacing, no decorative colour.

## Choosing mounts (pick from the request's intent; list the primary one first)
- "editor": the user edits a file's translations in a new layout (columns, cards, one verse at a time,
  a multi-column/multi-track workspace). It REPLACES the standard editor for a file.
- "page": a dashboard, report or workspace across files or the whole project; anything wide.
- "panel": a narrow (~300px) companion beside the verses — counts, checks, a list to jump through.
- "inline": something about one verse, under that verse.
- Add a second mount only when it genuinely works there (a panel that also makes sense as a page).
  Never add "panel" to a wide multi-column layout.`

export const TOOLS_DOMAIN_PROMPT = `## What Aquilla has — and does not have (ground every plan in this)
Aquilla is a Bible/content translation workspace. A project has FILES (a book, a document); a file has CELLS
in order, each with a ref (e.g. "MAT 1:1", or null for headings/paragraph cells), a SOURCE text and a TARGET
(the translation) per LANE (a target language/version; aquilla.editor.config lists lanes; reads take { lane }).
Cells carry validation, AI-draft state, comments, audio takes, footnotes and rule issues. Projects have a
TERMBASE (key terms with renderings) and per-cell term matches. Files are separate documents: two files of the
same book (e.g. a literal and a simplified text) are linked only by matching refs — join them by ref yourself.

Available through the bridge: files, cells (source/target/html/ref/chapter, validation, history panel, comments
counts/threads, audio), lanes, sections/chapters, the termbase and term matches, back-translations, AI drafting,
presence/locks, per-tool storage (per user), and — with read:web — websites the manifest names (aquilla.web.fetch).
Through aquilla.web.fetch from Door43 (see below) an extension CAN show unfoldingWord resources live: ULT/UST
text, word-level ALIGNMENTS (read from the aligned USFM), UGNT/UHB with lemmas, Strong's and morphology, TN, TQ,
TW articles and TWL links — matched to the project's cells by book/chapter/verse.
NOT available (state these as not possible instead of faking them):
- SAVING alignments or any shared extension data: there is no shared storage for extension data (aquilla.storage
  is per user and small), and Door43 is read-only from an extension. Viewing alignments is possible; editing and
  saving them is "not_possible" with that reason.
- Writing to Door43 or any website (read:web is GET only), or sites the manifest does not name.
- Alignment between the PROJECT'S own translation and the original (Aquilla stores no word links for project text).
Bible-translation basics: unfoldingWord resources (ULT literal text, UST simplified text, TN notes, TW key-term
articles, TQ questions, TA academy) are all keyed by book/chapter/verse; translators work verse by verse with
several of them side by side, and checkers validate. When a request needs data from this NOT-available list,
build everything else well and mark that requirement not_possible with the reason — never silently drop it.
A requirement that works only when the project has imported the data (Greek/Hebrew text, TN, TW, ULT/UST as
files) is "partial", with a note such as "works when the notes are imported as a file" — not "covered". Prefer
fetching unfoldingWord resources live from Door43 (read:web) over depending on imported copies.`

export const TOOLS_DOOR43_PROMPT = String.raw`## Door43 (unfoldingWord's open resources) — via aquilla.web.fetch, manifest "web": ["git.door43.org"]
Raw files: https://git.door43.org/unfoldingWord/<repo>/raw/branch/master/<path>   (text/plain; fetch per book)
Catalog:   https://git.door43.org/api/v1/catalog/search?owner=unfoldingWord&lang=en  (JSON; releases, subjects)
Book files are numbered: OT 01-GEN … 39-MAL; NT 41-MAT 42-MRK 43-LUK 44-JHN 45-ACT 46-ROM … 67-REV (no 40).
Map a project ref "MAT 1:1" to book code MAT, chapter 1, verse 1.
- en_ult / en_ust: <NN>-<BOOK>.usfm (e.g. 41-MAT.usfm). Literal / simplified English, ALIGNED to the original:
    \v 1 \zaln-s |x-strong="G09760" x-lemma="βίβλος" x-morph="Gr,N,,,,,NFS," x-occurrence="1" x-occurrences="1" x-content="Βίβλος"\*\w The|x-occurrence="1" x-occurrences="1"\w*
    \w book|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
  Each \zaln-s … \zaln-e\* milestone wraps the English \w words aligned to ONE original word (x-content, with
  x-strong/x-lemma/x-morph; x-occurrence says which occurrence in the verse). Milestones can nest (many-to-many).
  Plain text = the \w words in order; strip markers. Chapters: \c N; verses: \v N; \p, \q paragraphs.
- el-x-koine_ugnt (Greek NT) / hbo_uhb (Hebrew OT): <NN>-<BOOK>.usfm with \w word|lemma="…" strong="G…/H…" x-morph="…"\w*.
- en_tn  (Translation Notes): tn_<BOOK>.tsv — columns Reference, ID, Tags, SupportReference, Quote, Occurrence, Note
    (Reference "1:1"; Quote = original-language words; Note is Markdown; SupportReference rc://*/ta/man/translate/…).
- en_tq  (Translation Questions): tq_<BOOK>.tsv — Reference, ID, Tags, Quote, Occurrence, Question, Response.
- en_twl (Translation Words Links): twl_<BOOK>.tsv — Reference, ID, Tags, OrigWords, Occurrence, TWLink
    (TWLink rc://*/tw/dict/bible/kt/god → en_tw file bible/kt/god.md).
- en_tw  (Translation Words): bible/kt/<word>.md, bible/names/<word>.md, bible/other/<word>.md (Markdown article).
- en_ta  (Translation Academy): translate/<article>/01.md (title.md, sub-title.md beside it).
TSVs: first line is the header; split rows on newlines and fields on tabs; a literal backslash-n inside a Note is a line break.
Fetch each book file once, parse it into a { "chapter:verse": … } map, and look rows up by the cell's ref.
Door43 can be slow or rate-limit heavy use: show a per-track loading state and a clear error, and never refetch per verse.`
