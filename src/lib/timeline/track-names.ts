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

/** The stem every automatic track name is built from. */
const STEM = "Track"

/** `Track` → 0, `Track 3` → 3, anything else → null. The bare stem counts as
 *  slot 0 so it is simply the first entry in the same sequence. */
function numberOf(name: string): number | null {
  const trimmed = name.trim()
  if (trimmed === STEM) return 0
  const m = /^Track (\d+)$/.exec(trimmed)
  if (!m) return null
  const n = Number(m[1])
  // A leading zero would make "Track 01" claim slot 1 and then render as a name
  // this function would never generate — so only the canonical spelling counts.
  return String(n) === m[1] ? n : null
}

/**
 * The name to offer for the next added track, given every track on the file.
 *
 * Takes the tracks themselves rather than a list of names so callers cannot
 * accidentally pass a filtered set: a folder called "Track 2" still occupies
 * that name in the gutter, whatever kind it is, and two rows reading "Track 2"
 * is the confusion this exists to avoid.
 */
export function nextTrackName(tracks: readonly { name: string }[]): string {
  const taken = new Set<number>()
  for (const t of tracks) {
    const n = numberOf(t.name)
    if (n != null) taken.add(n)
  }
  let n = 0
  while (taken.has(n)) n += 1
  return n === 0 ? STEM : `${STEM} ${n}`
}
