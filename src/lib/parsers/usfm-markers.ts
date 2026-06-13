// Complete USFM 3.x marker taxonomy.
//
// This is the reference that lets us promise a Paratext-native consultant two
// things at once, provably:
//
//   1. NOTHING IS LOST. The original bytes are the source of truth (side-car);
//      export reinserts only translated runs, so any marker we don't model is
//      still preserved byte-for-byte. The taxonomy is NOT required for
//      round-trip — it's required for the second promise:
//
//   2. EVERYTHING TRANSLATABLE IS REACHABLE. Every marker whose content is
//      natural-language text a translator must localize is flagged
//      `translatable: true`. Reference/number/scaffolding markers (\fr, \xo,
//      verse numbers, callers) are `translatable: false`. A coverage analyzer
//      uses this to prove no translatable run is orphaned.
//
// Grounded in the USFM 3.1 spec AND the 110 distinct markers found across the
// real test corpus (Arabic NAV, Koli Kachhi, Suvali, Bestalu, ISV Nagamese …).
//
// USX note: USX is USFM's XML serialization; its `style` attributes are these
// same marker names (e.g. <char style="nd">, <note style="f">), so this
// taxonomy serves both formats.

export type MarkerCategory =
  | "identification"
  | "introduction"
  | "title"
  | "heading"
  | "chapter"
  | "verse"
  | "paragraph"
  | "poetry"
  | "list"
  | "table"
  | "note"
  | "crossref"
  | "char"
  | "milestone"
  | "figure"
  | "extension"
  | "peripheral"

export interface MarkerSpec {
  category: MarkerCategory
  /** Does this marker's own text run carry translatable natural language? */
  translatable: boolean
  /** Line-level block marker (paragraph/heading/title): begins a new block and
   *  ends the current verse-body run. False for inline char markers + notes. */
  structural: boolean
  /** Has a matching end marker (e.g. \nd…\nd*, \f…\f*). */
  paired: boolean
  /** Short human label used in coverage/conformance reports. */
  role: string
}

// Base marker families (numbered variants like s1/q2/mt3/li4/io2 normalize to
// the base by stripping trailing digits; the leading "+" nesting prefix and a
// trailing "*" end-marker are stripped before lookup).
const MARKERS: Record<string, MarkerSpec> = {
  // ── Identification ──────────────────────────────────────────────────────
  id:   { category: "identification", translatable: false, structural: true, paired: false, role: "book-id" },
  ide:  { category: "identification", translatable: false, structural: true, paired: false, role: "encoding" },
  sts:  { category: "identification", translatable: false, structural: true, paired: false, role: "status" },
  rem:  { category: "identification", translatable: false, structural: true, paired: false, role: "remark" },
  h:    { category: "identification", translatable: true,  structural: true, paired: false, role: "running-header" },
  toc:  { category: "identification", translatable: true,  structural: true, paired: false, role: "toc" },
  toca: { category: "identification", translatable: true,  structural: true, paired: false, role: "toc-alt" },
  usfm: { category: "identification", translatable: false, structural: true, paired: false, role: "usfm-version" },

  // ── Introduction ────────────────────────────────────────────────────────
  imt:  { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-major-title" },
  imte: { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-major-title-end" },
  is:   { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-section" },
  ip:   { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-paragraph" },
  ipi:  { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-paragraph-indented" },
  im:   { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-margin" },
  imi:  { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-margin-indented" },
  ipq:  { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-quote" },
  imq:  { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-margin-quote" },
  ipr:  { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-right" },
  iq:   { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-poetry" },
  ib:   { category: "introduction", translatable: false, structural: true, paired: false, role: "intro-blank" },
  ili:  { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-list-item" },
  iot:  { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-outline-title" },
  io:   { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-outline-entry" },
  iex:  { category: "introduction", translatable: true,  structural: true, paired: false, role: "intro-explanatory" },
  ie:   { category: "introduction", translatable: false, structural: true, paired: false, role: "intro-end" },
  ior:  { category: "introduction", translatable: true,  structural: false, paired: true, role: "intro-outline-ref" },
  iqt:  { category: "introduction", translatable: true,  structural: false, paired: true, role: "intro-quoted-text" },

  // ── Titles / major headings ─────────────────────────────────────────────
  mt:   { category: "title",   translatable: true,  structural: true, paired: false, role: "main-title" },
  mte:  { category: "title",   translatable: true,  structural: true, paired: false, role: "main-title-end" },
  ms:   { category: "heading", translatable: true,  structural: true, paired: false, role: "major-section" },
  mr:   { category: "heading", translatable: true,  structural: true, paired: false, role: "major-section-ref" },
  s:    { category: "heading", translatable: true,  structural: true, paired: false, role: "section-heading" },
  sr:   { category: "heading", translatable: true,  structural: true, paired: false, role: "section-ref" },
  r:    { category: "heading", translatable: true,  structural: true, paired: false, role: "parallel-ref" },
  sp:   { category: "heading", translatable: true,  structural: true, paired: false, role: "speaker" },
  sd:   { category: "heading", translatable: false, structural: true, paired: false, role: "semantic-division" },
  d:    { category: "heading", translatable: true,  structural: true, paired: false, role: "descriptive-title" },

  // ── Chapter / verse ─────────────────────────────────────────────────────
  c:    { category: "chapter", translatable: false, structural: true, paired: false, role: "chapter" },
  cl:   { category: "chapter", translatable: true,  structural: true, paired: false, role: "chapter-label" },
  cp:   { category: "chapter", translatable: true,  structural: true, paired: false, role: "chapter-published" },
  cd:   { category: "chapter", translatable: true,  structural: true, paired: false, role: "chapter-description" },
  ca:   { category: "chapter", translatable: false, structural: false, paired: true, role: "chapter-alt" },
  v:    { category: "verse",   translatable: true,  structural: true, paired: false, role: "verse" },
  va:   { category: "verse",   translatable: false, structural: false, paired: true, role: "verse-alt" },
  vp:   { category: "verse",   translatable: true,  structural: false, paired: true, role: "verse-published" },

  // ── Paragraphs (own text belongs to the surrounding verse) ──────────────
  p:    { category: "paragraph", translatable: false, structural: true, paired: false, role: "paragraph" },
  m:    { category: "paragraph", translatable: false, structural: true, paired: false, role: "margin-paragraph" },
  po:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "letter-opening" },
  pr:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "right-paragraph" },
  cls:  { category: "paragraph", translatable: false, structural: true, paired: false, role: "closure" },
  pmo:  { category: "paragraph", translatable: false, structural: true, paired: false, role: "embedded-opening" },
  pm:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "embedded-paragraph" },
  pmc:  { category: "paragraph", translatable: false, structural: true, paired: false, role: "embedded-closing" },
  pmr:  { category: "paragraph", translatable: false, structural: true, paired: false, role: "embedded-refrain" },
  pi:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "indented-paragraph" },
  pc:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "centered-paragraph" },
  mi:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "margin-indented" },
  nb:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "no-break" },
  b:    { category: "paragraph", translatable: false, structural: true, paired: false, role: "blank-line" },
  ph:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "paragraph-hanging" },
  lit:  { category: "paragraph", translatable: true,  structural: true, paired: false, role: "liturgical" },

  // ── Poetry ──────────────────────────────────────────────────────────────
  q:    { category: "poetry", translatable: false, structural: true, paired: false, role: "poetry-line" },
  qr:   { category: "poetry", translatable: false, structural: true, paired: false, role: "poetry-right" },
  qc:   { category: "poetry", translatable: false, structural: true, paired: false, role: "poetry-centered" },
  qa:   { category: "poetry", translatable: true,  structural: true, paired: false, role: "acrostic-heading" },
  qm:   { category: "poetry", translatable: false, structural: true, paired: false, role: "poetry-embedded" },
  qd:   { category: "poetry", translatable: true,  structural: true, paired: false, role: "hebrew-note" },
  qs:   { category: "poetry", translatable: true,  structural: false, paired: true, role: "selah" },
  qac:  { category: "poetry", translatable: true,  structural: false, paired: true, role: "acrostic-char" },

  // ── Lists ───────────────────────────────────────────────────────────────
  lh:   { category: "list", translatable: true,  structural: true, paired: false, role: "list-header" },
  li:   { category: "list", translatable: false, structural: true, paired: false, role: "list-item" },
  lf:   { category: "list", translatable: true,  structural: true, paired: false, role: "list-footer" },
  lim:  { category: "list", translatable: false, structural: true, paired: false, role: "list-item-embedded" },
  litl: { category: "list", translatable: true,  structural: false, paired: true, role: "list-total" },
  lik:  { category: "list", translatable: true,  structural: false, paired: true, role: "list-key" },
  liv:  { category: "list", translatable: true,  structural: false, paired: true, role: "list-value" },

  // ── Tables ──────────────────────────────────────────────────────────────
  tr:   { category: "table", translatable: false, structural: true, paired: false, role: "table-row" },
  th:   { category: "table", translatable: true,  structural: false, paired: false, role: "table-head" },
  thr:  { category: "table", translatable: true,  structural: false, paired: false, role: "table-head-right" },
  tc:   { category: "table", translatable: true,  structural: false, paired: false, role: "table-cell" },
  tcr:  { category: "table", translatable: true,  structural: false, paired: false, role: "table-cell-right" },

  // ── Notes (footnotes / endnotes) ───────────────────────────────────────
  f:    { category: "note", translatable: false, structural: false, paired: true, role: "footnote" },
  fe:   { category: "note", translatable: false, structural: false, paired: true, role: "endnote" },
  fr:   { category: "note", translatable: false, structural: false, paired: false, role: "footnote-ref" },
  fq:   { category: "note", translatable: true,  structural: false, paired: false, role: "footnote-quote" },
  fqa:  { category: "note", translatable: true,  structural: false, paired: false, role: "footnote-alt-translation" },
  fk:   { category: "note", translatable: true,  structural: false, paired: false, role: "footnote-keyword" },
  fl:   { category: "note", translatable: true,  structural: false, paired: false, role: "footnote-label" },
  fw:   { category: "note", translatable: false, structural: false, paired: false, role: "footnote-witness" },
  fp:   { category: "note", translatable: true,  structural: false, paired: false, role: "footnote-paragraph" },
  fv:   { category: "note", translatable: false, structural: false, paired: true, role: "footnote-verse-num" },
  ft:   { category: "note", translatable: true,  structural: false, paired: false, role: "footnote-text" },
  fdc:  { category: "note", translatable: true,  structural: false, paired: true, role: "footnote-deuterocanon" },
  fm:   { category: "note", translatable: false, structural: false, paired: true, role: "footnote-mark" },

  // ── Cross references ────────────────────────────────────────────────────
  x:    { category: "crossref", translatable: false, structural: false, paired: true, role: "xref" },
  xo:   { category: "crossref", translatable: false, structural: false, paired: false, role: "xref-origin" },
  xk:   { category: "crossref", translatable: true,  structural: false, paired: false, role: "xref-keyword" },
  xq:   { category: "crossref", translatable: true,  structural: false, paired: false, role: "xref-quote" },
  xt:   { category: "crossref", translatable: true,  structural: false, paired: true, role: "xref-target" },
  xta:  { category: "crossref", translatable: true,  structural: false, paired: true, role: "xref-target-added" },
  xop:  { category: "crossref", translatable: true,  structural: false, paired: true, role: "xref-origin-published" },
  xot:  { category: "crossref", translatable: true,  structural: false, paired: true, role: "xref-ot" },
  xnt:  { category: "crossref", translatable: true,  structural: false, paired: true, role: "xref-nt" },
  xdc:  { category: "crossref", translatable: true,  structural: false, paired: true, role: "xref-deuterocanon" },

  // ── Character / word-level (inline; content translatable unless ref/num) ─
  add:   { category: "char", translatable: true,  structural: false, paired: true, role: "translator-addition" },
  bk:    { category: "char", translatable: true,  structural: false, paired: true, role: "book-quote" },
  dc:    { category: "char", translatable: true,  structural: false, paired: true, role: "deuterocanon" },
  k:     { category: "char", translatable: true,  structural: false, paired: true, role: "keyword" },
  nd:    { category: "char", translatable: true,  structural: false, paired: true, role: "divine-name" },
  ord:   { category: "char", translatable: true,  structural: false, paired: true, role: "ordinal" },
  pn:    { category: "char", translatable: true,  structural: false, paired: true, role: "proper-name" },
  png:   { category: "char", translatable: true,  structural: false, paired: true, role: "geographic-name" },
  addpn: { category: "char", translatable: true,  structural: false, paired: true, role: "proper-name-added" },
  qt:    { category: "char", translatable: true,  structural: false, paired: true, role: "quoted-text" },
  sig:   { category: "char", translatable: true,  structural: false, paired: true, role: "signature" },
  sls:   { category: "char", translatable: true,  structural: false, paired: true, role: "secondary-source" },
  tl:    { category: "char", translatable: true,  structural: false, paired: true, role: "transliterated" },
  wj:    { category: "char", translatable: true,  structural: false, paired: true, role: "words-of-jesus" },
  em:    { category: "char", translatable: true,  structural: false, paired: true, role: "emphasis" },
  bd:    { category: "char", translatable: true,  structural: false, paired: true, role: "bold" },
  bdit:  { category: "char", translatable: true,  structural: false, paired: true, role: "bold-italic" },
  it:    { category: "char", translatable: true,  structural: false, paired: true, role: "italic" },
  no:    { category: "char", translatable: true,  structural: false, paired: true, role: "normal" },
  sc:    { category: "char", translatable: true,  structural: false, paired: true, role: "small-caps" },
  sup:   { category: "char", translatable: true,  structural: false, paired: true, role: "superscript" },
  rq:    { category: "char", translatable: true,  structural: false, paired: true, role: "inline-quote-ref" },
  rb:    { category: "char", translatable: true,  structural: false, paired: true, role: "ruby-base" },
  pro:   { category: "char", translatable: false, structural: false, paired: true, role: "pronunciation" },
  w:     { category: "char", translatable: true,  structural: false, paired: true, role: "wordlist-entry" },
  wg:    { category: "char", translatable: true,  structural: false, paired: true, role: "wordlist-greek" },
  wh:    { category: "char", translatable: true,  structural: false, paired: true, role: "wordlist-hebrew" },
  wa:    { category: "char", translatable: true,  structural: false, paired: true, role: "wordlist-aramaic" },

  // ── Milestones (self-closing or start/end pairs; structural metadata) ────
  cat:   { category: "milestone", translatable: false, structural: false, paired: true, role: "category" },
  ts:    { category: "milestone", translatable: false, structural: false, paired: true, role: "translator-section" },

  // ── Figures ─────────────────────────────────────────────────────────────
  fig:   { category: "figure", translatable: true,  structural: false, paired: true, role: "figure-caption" },

  // ── Tables (centered variants, usfm.sty thc1-10/tcc1-10) ────────────────
  thc:  { category: "table", translatable: true,  structural: false, paired: false, role: "table-head-centered" },
  tcc:  { category: "table", translatable: true,  structural: false, paired: false, role: "table-cell-centered" },

  // ── Notes / crossrefs (usfm.sty extensions) ─────────────────────────────
  fs:       { category: "note",     translatable: true,  structural: false, paired: true, role: "footnote-summary" },
  xtSee:    { category: "crossref", translatable: false, structural: false, paired: true, role: "xref-see" },
  xtSeeAlso:{ category: "crossref", translatable: false, structural: false, paired: true, role: "xref-see-also" },

  // ── Character-level (usfm.sty additions) ────────────────────────────────
  jmp:  { category: "char", translatable: true,  structural: false, paired: true, role: "link-text" },
  ndx:  { category: "char", translatable: true,  structural: false, paired: true, role: "index-entry" },
  wr:   { category: "char", translatable: true,  structural: false, paired: true, role: "wordlist-real" },

  // ── Paragraph-level (deprecated usfm.sty variants) ──────────────────────
  pb:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "page-break" },
  phi:  { category: "paragraph", translatable: false, structural: true, paired: false, role: "paragraph-hanging-indent" },
  ps:   { category: "paragraph", translatable: false, structural: true, paired: false, role: "paragraph-no-chapter-break" },
  psi:  { category: "paragraph", translatable: false, structural: true, paired: false, role: "paragraph-indented-no-break" },

  // ── Peripheral / publication matter (OccursUnder \id; NOT in the
  //    verse-terminating set, matching prior unknown-marker behavior) ───────
  periph:  { category: "peripheral", translatable: true,  structural: true, paired: false, role: "peripheral-division" },
  conc:    { category: "peripheral", translatable: true,  structural: true, paired: false, role: "concordance" },
  cov:     { category: "peripheral", translatable: true,  structural: true, paired: false, role: "cover" },
  glo:     { category: "peripheral", translatable: true,  structural: true, paired: false, role: "glossary" },
  idx:     { category: "peripheral", translatable: true,  structural: true, paired: false, role: "back-index" },
  intro:   { category: "peripheral", translatable: true,  structural: true, paired: false, role: "front-intro" },
  maps:    { category: "peripheral", translatable: true,  structural: true, paired: false, role: "map-index" },
  pref:    { category: "peripheral", translatable: true,  structural: true, paired: false, role: "preface" },
  pub:     { category: "peripheral", translatable: true,  structural: true, paired: false, role: "publication-data" },
  spine:   { category: "peripheral", translatable: true,  structural: true, paired: false, role: "spine" },
  pubinfo: { category: "peripheral", translatable: false, structural: true, paired: false, role: "publication-info" },
  restore: { category: "peripheral", translatable: false, structural: true, paired: false, role: "project-restore" },

  // ── Custom z-namespace (Paratext project-defined, zpa-* family) ─────────
  "zpa-d":  { category: "extension", translatable: false, structural: false, paired: true, role: "z-periph-description" },
  "zpa-xb": { category: "extension", translatable: false, structural: false, paired: true, role: "z-book-ref" },
  "zpa-xc": { category: "extension", translatable: false, structural: false, paired: true, role: "z-chapter-ref" },
  "zpa-xv": { category: "extension", translatable: false, structural: false, paired: true, role: "z-verse-ref" },
}

/** Normalize a raw marker token to its taxonomy base name.
 *  - strips a leading "+" (nested character marker, e.g. \+nd)
 *  - strips a trailing "*" (end marker, e.g. \nd*)
 *  - strips trailing digits (level variants, e.g. s1→s, mt3→mt, li4→li,
 *    io2→io) — but only when the digit-stripped base is itself known, so we
 *    don't mangle a genuinely distinct marker. */
export function normalizeMarker(raw: string): string {
  const n = raw.replace(/^\\/, "").replace(/^\+/, "").replace(/\*$/, "")
  if (MARKERS[n]) return n
  const stripped = n.replace(/\d+$/, "")
  if (stripped !== n && MARKERS[stripped]) return stripped
  return n
}

export function classifyMarker(raw: string): MarkerSpec | undefined {
  return MARKERS[normalizeMarker(raw)]
}

/** Is this an end marker (e.g. \nd*, \f*, \+xt*)? */
export function isEndMarker(raw: string): boolean {
  return raw.endsWith("*")
}

/** Is this a nested character marker (\+nd, \+xt …)? */
export function isNestedMarker(raw: string): boolean {
  return raw.replace(/^\\/, "").startsWith("+")
}

/** Categories whose (structural) markers end the current verse. Paragraph,
 *  poetry, list, and table markers are structural BLOCKS but flow WITHIN a
 *  verse (e.g. \q1 poetry continuation, \p mid-verse paragraph), so they do
 *  NOT terminate it — matching the validated lossless-parser behavior. A
 *  verse ends only at the next verse/chapter, a section-or-higher heading, a
 *  title, or any identification/introduction marker (verses don't appear in
 *  the header/intro region). */
const VERSE_TERMINATING_CATEGORIES: ReadonlySet<MarkerCategory> = new Set<MarkerCategory>([
  "verse",
  "chapter",
  "heading",
  "title",
  "identification",
  "introduction",
])

/** True when the marker begins a new block that ends the current verse body
 *  run (used by the verse extractor). Unknown markers, nested markers, and end
 *  markers are NON-terminating (safer: keeps unknown content inside the verse
 *  so it round-trips and stays reachable rather than splitting a verse). */
export function terminatesVerse(raw: string): boolean {
  if (isNestedMarker(raw) || isEndMarker(raw)) return false
  const spec = classifyMarker(raw)
  return spec ? spec.structural && VERSE_TERMINATING_CATEGORIES.has(spec.category) : false
}

/** Markers whose own text content should be surfaced as a localizable unit. */
export function isTranslatable(raw: string): boolean {
  return classifyMarker(raw)?.translatable ?? false
}

export const KNOWN_MARKER_BASES: ReadonlySet<string> = new Set(Object.keys(MARKERS))
