// Which version a take is (AQU-2327): 1 for an original, 2 for its first
// saved version, counted up the chain of takes it was made from
// (`referenceAudioId`). A take saved over (removed when its replacement was
// saved, Sam, Nov 2) isn't counted, so "Save" keeps the take's name and
// number; the chain still runs through it, for History.

export function versionOfId(
  atts: Record<string, { referenceAudioId?: string | null; isDeleted?: boolean }>,
  from: string | null | undefined,
): number {
  let n = 1
  let ref = from
  const seen = new Set<string>()
  while (ref && !seen.has(ref) && atts[ref]) {
    seen.add(ref)
    if (!atts[ref].isDeleted) n += 1
    ref = atts[ref].referenceAudioId
  }
  return n
}
