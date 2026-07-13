// Read-only "karaoke while listening" renderer. When a cell is NOT being
// actively edited, the target text renders as plain text (not a ProseMirror
// editor), so the editor's karaoke ProseMirror plugin can't paint the active
// word. This component paints the active-word highlight over the plain text as
// audio plays, so "play the audio → watch the text highlight" works without
// entering edit mode (AQU-521).
//
// Scope: plain (non-USFM, non-rich-HTML) target text. The `range` offsets are
// plain-text offsets, matching how WordTiming.start/end are computed. USFM /
// rich-HTML read views fall back to the normal renderer (see EditorTable).

interface KaraokeReadTextProps {
  text: string
  /** Plain-text offset span [start, end) of the word to highlight. */
  range: { start: number; end: number }
}

export function KaraokeReadText({ text, range }: KaraokeReadTextProps) {
  const start = Math.max(0, Math.min(text.length, range.start))
  const end = Math.max(start, Math.min(text.length, range.end))

  // Nothing valid to highlight — render the text untouched.
  if (start >= end) return <span>{text}</span>

  const before = text.slice(0, start)
  const active = text.slice(start, end)
  const after = text.slice(end)

  return (
    <span>
      {before && <span>{before}</span>}
      <span className="karaoke-active">{active}</span>
      {after && <span>{after}</span>}
    </span>
  )
}
