export function buildCommitMessage(
  filesChanged: Array<{ name: string; cellsChanged: number }>,
): string {
  const totalCells = filesChanged.reduce((n, f) => n + f.cellsChanged, 0)
  const summary = `codex-web: sync ${totalCells} cell${totalCells === 1 ? "" : "s"} across ${filesChanged.length} file${filesChanged.length === 1 ? "" : "s"}`
  const detail = filesChanged
    .filter((f) => f.cellsChanged > 0)
    .map((f) => `- ${f.name}: ${f.cellsChanged} cell${f.cellsChanged === 1 ? "" : "s"} changed`)
    .join("\n")
  return `${summary}\n\n${detail}`.trim()
}
