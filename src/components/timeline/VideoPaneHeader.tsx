// The video column's header — the same row the chip strip provides for the
// text column (2026-08-08, Sam's sketch): identical chrome so the two read as
// one line split by the divider. The pill carries the linked file's name.
//
// Extracted 2026-08-11: both the pane and its error card render this, so it
// cannot live inside either of them.

export function VideoPaneHeader({ src }: { src: string }) {
  let basename = src
  try {
    basename = decodeURIComponent(new URL(src).pathname.split("/").pop() || src)
  } catch {
    /* not a parseable URL — show it raw */
  }
  return (
    <div
      data-testid="video-pane-header"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/20 px-4 py-1.5"
    >
      <span className="text-xs font-medium text-muted-foreground">Video</span>
      <span className="inline-flex min-w-0 items-center rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80">
        <span className="truncate font-mono">{basename}</span>
      </span>
    </div>
  )
}
