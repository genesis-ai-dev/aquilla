/** Pending heads use the workspace's cellId + NUL + lane key convention.
 * Check only pending cells in the active lane; other lanes remain dormant.
 * A predecessor or competing head never confirms the queued event itself.
 */
export function confirmedTargetHeadKeys(
  pending: ReadonlyMap<string, { eventId: string }>,
  activeLane: string,
  readProjectedHead: (cellId: string) => string | null | undefined,
): string[] {
  const confirmed: string[] = []
  for (const [key, head] of pending) {
    const separator = key.indexOf("\u0000")
    if (separator < 0 || key.slice(separator + 1) !== activeLane) continue
    if (readProjectedHead(key.slice(0, separator)) === head.eventId) confirmed.push(key)
  }
  return confirmed
}
