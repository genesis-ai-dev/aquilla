export function CellLoadingProgress({ progress }: {
  progress: { loaded: number; total: number | null } | null
}) {
  if (!progress) return null
  const percent = progress.total !== null && Number.isFinite(progress.total) && progress.total > 0
    ? Math.min(100, Math.max(0, Math.floor(progress.loaded / progress.total * 100)))
    : null
  if (percent === null) return null
  return <span className="tabular-nums">{` · ${percent}%`}</span>
}
