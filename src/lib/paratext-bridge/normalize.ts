// Normalized text for `textHash`: the hash that drives overlay staleness,
// translation-memory lookup and cross-project dedupe. Unlike `rawHash` it must
// NOT change when only whitespace, line endings or Unicode composition differ.
//
// Markers stay in the text (a footnote is content a translator sees), but their
// spelling is canonicalised: `\+nd` → `\nd`, surrounding whitespace collapsed.

export function normalizeUnitText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\\\+/g, "\\")        // nested-marker plus sign is presentation only
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")  // runs of horizontal whitespace
    .replace(/ ?\n ?/g, "\n")       // no space around line breaks
    .replace(/\n+/g, "\n")
    .trim()
}
