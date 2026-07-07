// Repetition auto-propagation engine (Matecat-parity run) —
// https://guides.matecat.com/autopropagation: confirming a repeated segment
// propagates its translation to all same-source segments project-wide.
// Pure function: the caller (editor commit path, behind a flag) turns the
// returned updates into target.cell.commit events.

export interface PropagationSegment {
  id: string
  source: string
  translated: string
  status: "empty" | "unvalidated" | "validated"
}

export interface PropagationUpdate {
  id: string
  translated: string
  propagated: true
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim()

/**
 * Segments receiving the confirmed translation: identical normalized source,
 * not the confirmed segment itself, not validated (approved segments never
 * change silently — same rule as Matecat), and not already carrying the
 * identical translation.
 */
export function propagateTranslation(
  confirmed: { id: string; source: string; translated: string },
  segments: PropagationSegment[],
): PropagationUpdate[] {
  const key = normalize(confirmed.source)
  if (!key || !confirmed.translated.trim()) return []
  const updates: PropagationUpdate[] = []
  for (const seg of segments) {
    if (seg.id === confirmed.id) continue
    if (seg.status === "validated") continue
    if (normalize(seg.source) !== key) continue
    if (seg.translated.trim() === confirmed.translated.trim()) continue
    updates.push({ id: seg.id, translated: confirmed.translated, propagated: true })
  }
  return updates
}
