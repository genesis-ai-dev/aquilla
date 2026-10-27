/** How many target languages a person can still translate into. Archived lanes
 *  are closed, so they do not count. A project with no lane rows yet still has
 *  its one target language, plus any extra tags stored the old way. */
export function openTargetLaneCount(project: {
  lanes?: readonly { role: string; archivedAt?: string | null }[] | null
  targetLanes?: readonly string[] | null
  archivedLanes?: readonly string[] | null
}): number {
  const rows = project.lanes
  if (rows && rows.length > 0) {
    return rows.filter((lane) => lane.role === "target" && !lane.archivedAt).length
  }
  const archived = new Set(project.archivedLanes ?? [])
  const extras = (project.targetLanes ?? []).filter((tag) => tag !== "" && !archived.has(tag))
  return 1 + extras.length
}
