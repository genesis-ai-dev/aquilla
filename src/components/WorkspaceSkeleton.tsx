// Placeholder skeleton shown while the workspace session is still loading.
// Replaces the bare "Loading..." text with neutral block-level placeholders
// so the layout doesn't pop on hydration.

export function WorkspaceSkeleton() {
  return (
    <div className="p-8 space-y-3" aria-busy="true" aria-label="Loading workspace">
      <div className="h-8 w-1/3 rounded-md bg-muted/60 animate-pulse" />
      <div className="h-4 w-2/3 rounded bg-muted/40 animate-pulse" />
      <div className="space-y-2 pt-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-6 w-full rounded bg-muted/30 animate-pulse" />
        ))}
      </div>
    </div>
  )
}
