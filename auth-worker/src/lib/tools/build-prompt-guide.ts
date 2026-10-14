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
presence/locks, per-tool storage (per user), websites the manifest names (read:web), and (apiRev 7):
- creating and REFRESHING project files from anything an extension fetches and parses (files.upsert, write:files):
  that is how outside resources become project content that is live-linked (a "Check for updates" action re-runs it),
- shared, attributed, revertible records of your own — alignments, annotations, links — in hidden data files
  (aquilla.data.*, write:data), anchored to cells with a drift check when the cell changes,
- reading cells by ref across many files at once (cells.byRef) and file groups/tags (files.list, files.group),
- headless actions (buttons, check on project open) and export formats in the export dialog.
NOT available (state these as not possible instead of faking them):
- Writing to Door43 or any website (read:web is GET only), or sites the manifest does not name. Results go back
  out through an export (the user uploads it).
- Running on a server or on a schedule while nobody has the project open ("check on open" is the closest).
- Pushing changes to a remote repository.
Bible-translation basics: unfoldingWord resources (ULT literal text, UST simplified text, TN notes, TW key-term
articles, TQ questions, TA academy) are all keyed by book/chapter/verse; translators work verse by verse with
several of them side by side, and checkers validate. When a request needs data from this NOT-available list,
build everything else well and mark that requirement not_possible with the reason — never silently drop it.
Resources the team TRANSLATES or keeps beside its work belong IN the project: import them as files (files.upsert)
rather than fetching them on every view — then they are translatable, searchable, versioned, offline-safe and
update through the extension's refresh action.
A requirement that works only when the project has imported the data (Greek/Hebrew text, TN, TW, ULT/UST as files)
and THIS extension does not import it itself is "partial",
with a note such as "works once the importer has run" — not "covered".`

export const TOOLS_DOOR43_PROMPT = String.raw`## Door43 (unfoldingWord's open resources) — manifest "web": ["git.door43.org"]
Raw files: https://git.door43.org/unfoldingWord/<repo>/raw/branch/master/<path>   (text/plain; one per book)
Zipball:   https://git.door43.org/unfoldingWord/<repo>/archive/master.zip   (aquilla.web.fetch(url, { as: "bytes" }) + aq.zip.read;
           use it for en_tw — ~1,000 articles in one request)
Latest commit: https://git.door43.org/api/v1/repos/unfoldingWord/<repo>/branches/master  (JSON: commit.id — the sha for "check for updates")
Book files are numbered: OT 01-GEN … 39-MAL; NT 41-MAT 42-MRK 43-LUK 44-JHN 45-ACT 46-ROM … 67-REV (no 40).
- en_ult / en_ust: <NN>-<BOOK>.usfm, ALIGNED to the original. aq.parse.usfm gives each verse's words with their
    \zaln-s milestones: each milestone's attrs (x-content, x-strong, x-lemma, x-morph, x-occurrence, x-occurrences) is ONE
    original word; the English words inside it are aligned to it; milestones nest for many-to-many.
- el-x-koine_ugnt (Greek NT) / hbo_uhb (Hebrew OT): <NN>-<BOOK>.usfm; words carry lemma, strong, x-morph.
- en_tn  tn_<BOOK>.tsv: Reference, ID, Tags, SupportReference, Quote, Occurrence, Note (Reference "1:1"; Quote = original-language
    words + Occurrence; Note is Markdown with a literal \n for line breaks).
- en_tq  tq_<BOOK>.tsv: Reference, ID, Tags, Quote, Occurrence, Question, Response.
- en_twl twl_<BOOK>.tsv: Reference, ID, Tags, OrigWords, Occurrence, TWLink (rc://*/tw/dict/bible/kt/god → en_tw bible/kt/god.md).
- en_tw  bible/kt|names|other/<word>.md (Markdown article: # title, ## sections).
- en_ta  translate/<article>/01.md (title.md beside it).

### "An unfoldingWord editor" = three cooperating extensions (build the one asked for; mention the others)
1. IMPORTER (mounts ["page"], scopes read:web + write:files + write:data, actions [{ id:"import", label:"Import unfoldingWord
   resources", where:["settings","menu"] }, { id:"refresh", label:"Check Door43 for updates", where:["bar","settings"], onOpen:true }]):
   for the chosen books, files.upsert one file per resource and book with key "uw:<res>:<BOOK>", tags ["uw", "uw:<res>",
   "book:<BOOK>"], group "uw:<BOOK>", meta { repo, sha }:
   ULT/UST cells keyed by ref (value = verse text, ref "TIT 1:1"), raw = the USFM; UGNT/UHB kind "reference", cell metadata
   { words:[{ text, lemma, strong, morph }] }; TN/TQ cells keyed by the TSV ID (value = Note / Question, ref from Reference,
   metadata = the other columns); TWL kind "reference", value OrigWords, metadata { article:"kt/god", occurrence }; TW one file per
   category ("uw:tw:kt"), cells keyed "<article>|<section>|<n>" with ref "tw:kt/god". The source alignment of ULT/UST goes to
   aquilla.data.put("uw.alignment", "<BOOK> <c>:<v>|ult", { groups:[{ src:[{w,occ,occs,strong,lemma,morph}], tgt:[{w,occ}] }] },
   { coll:"<book>", anchor:{ fileId, cellId, side:"source" } }). Refresh: compare the stored sha, re-fetch changed books,
   re-upsert (only changed cells change). Report with aquilla.action.progress / done.
2. EDITOR (mounts ["page","editor"], scopes read:cells + write:target + write:data): files.group(context.file) or files.list
   ({ tags:["uw","book:TIT"] }); per verse, cells.byRef({ refs:[ref], tags:["uw","book:TIT"] }) gives ULT, UST, UGNT/UHB words,
   TN, TQ and TWL in one call (TW article cells via cells.byRef({ refs:["tw:kt/god"], tags:["uw:tw"] })). The translator types the
   gateway-language text into the target of each translatable cell (aquilla.cells.commit or aq.TargetEditor). Gateway-language
   alignment: drag target words onto original words; save with aquilla.data.put("uw.alignment-gl", "<ref>|<lane>", { groups },
   { coll, anchor:{ fileId:ultFileId, cellId, side:"target" } }); on read, drift "changed" means the translation changed: re-resolve
   each target word by text + occurrence, keep the ones still found (mark "verify") and show missing ones as unaligned.
   Highlight a TN Quote in UGNT by matching words + occurrence, and in the translation through the alignment.
3. EXPORTER (exports [{ id:"aligned-usfm", label:"Aligned USFM", extension:"usfm", tags:["uw:ult"] }, { id:"uw-tsv", label:
   "unfoldingWord TSV", extension:"tsv", tags:["uw:tn"] }]): files.source(fileId) for the original USFM, the target cells and
   "uw.alignment-gl" records → rebuild each verse as \zaln-s |x-strong="…" x-lemma="…" x-morph="…" x-occurrence="n"
   x-occurrences="m" x-content="…"\*\w word|x-occurrence="n" x-occurrences="m"\w*\zaln-e\*; unaligned words as bare \w…\w*;
   TSV: the original rows with the translated Note/Question in place (re-escape newlines as \n). aquilla.export.deliver(files).
Door43 can be slow or rate-limit heavy use: fetch per book (or the zipball) once, show progress, never per verse.`
