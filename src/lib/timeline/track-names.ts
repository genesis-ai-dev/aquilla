// What a brand-new track is called. (AQU-646 stage 6J)
//
// Sam, 2026-08-27: "it should be something super incredibly boring… Think of it
// as like file creation: if a file is saved with a unique name it saves just
// fine; if it's a non-unique name it shows up with a little one in parentheses.
// So we don't need the parentheses, but we'd want the numbers."
//
// So: "Track", then "Track 1", "Track 2", … and — this is the file-save part —
// the number is the LOWEST one not currently taken, not one past the highest.
// Delete "Track 1" and the next track you add is called "Track 1" again,
// exactly as a folder gives a filename back once you remove the file holding
// it. Rename a track away from a numbered name and it frees that number too,
// because the only thing consulted is what the tracks are called right now.
//
// DELIBERATELY NOT `nextTakeLabel` (TakesStrip.tsx), which is the other
// numbered-name function in the app and is max + 1. That is right for takes: a
// take number is a record of the order they were performed in, so reusing a
// deleted take's number would make two recordings' names mean the same thing at
// different times. A track name is just a label on a row — nothing refers back
// to it — so reuse costs nothing and keeps the numbers small. Two different
// answers because they are two different questions.

/** The stems the automatic names are built from. Both are STORED, so both are
 *  English whatever the creator's UI language — see `nextNameForStem`. */
const TRACK_STEM = "Track"
const FOLDER_STEM = "Folder"

/** `Track` → 0, `Track 3` → 3, anything else → null. The bare stem counts as
 *  slot 0 so it is simply the first entry in the same sequence. */
function numberOf(name: string, stem: string): number | null {
  const trimmed = name.trim()
  if (trimmed === stem) return 0
  if (!trimmed.startsWith(`${stem} `)) return null
  const rest = trimmed.slice(stem.length + 1)
  if (!/^\d+$/.test(rest)) return null
  const n = Number(rest)
  // A leading zero would make "Track 01" claim slot 1 and then render as a name
  // this function would never generate — so only the canonical spelling counts.
  return String(n) === rest ? n : null
}

/**
 * The lowest free `<stem> <n>` across every row on the file.
 *
 * Takes the rows themselves rather than a list of names so callers cannot
 * accidentally pass a filtered set: a folder called "Track 2" still occupies
 * that name in the gutter, whatever kind it is, and two rows reading "Track 2"
 * is the confusion this exists to avoid. Each stem counts only its OWN
 * sequence, so a file can hold "Track 1" and "Folder 1" at once — they are not
 * the same name and never read as one.
 */
function nextNameForStem(rows: readonly { name: string }[], stem: string): string {
  const taken = new Set<number>()
  for (const r of rows) {
    const n = numberOf(r.name, stem)
    if (n != null) taken.add(n)
  }
  let n = 0
  while (taken.has(n)) n += 1
  return n === 0 ? stem : `${stem} ${n}`
}

/** The name to offer for the next added track, given every row on the file. */
export function nextTrackName(tracks: readonly { name: string }[]): string {
  return nextNameForStem(tracks, TRACK_STEM)
}

/**
 * …and for the next folder. (2026-08-28)
 *
 * Folders used to be stored under `t("editor.timeline.trackAddFolder")` — the
 * MENU LABEL, translated. So a folder made by someone working in Thai was
 * stored as "โฟลเดอร์" and every collaborator saw that word in their gutter,
 * whatever language they were in; and because the label is a constant, every
 * folder on a file was called the same thing. The i18n note beside that key
 * already stated the rule this restores: an automatic name is DATA, not copy.
 * The menu label stays translated — only what gets STORED changed.
 */
export function nextFolderName(rows: readonly { name: string }[]): string {
  return nextNameForStem(rows, FOLDER_STEM)
}
