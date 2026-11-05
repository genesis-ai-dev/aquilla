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

import { timingAddressesText } from "@/lib/audio/timings"

interface KaraokeReadTextProps {
  text: string
  /**
   * Plain-text offset span [start, end) of the word to highlight, and — when
   * the caller knows it — the word that span is supposed to be.
   */
  range: { start: number; end: number; word?: string }
}

export function KaraokeReadText({ text, range }: KaraokeReadTextProps) {
  // AQU-2254: the offsets were measured against some wording, and `text` is
  // the wording now. An AI transcript cleanup rewrites a cell's text under
  // timings that keep the old layout, which slides every span after the edit
  // onto the wrong letters while the audio clock stays right. The component
  // that paints is the one holding the text, so it is the one that checks:
  // a span that no longer selects its own word paints nothing at all, because
  // highlighting the wrong word claims the audio is saying something it is not.
  const { word } = range
  if (word !== undefined && !timingAddressesText({ start: range.start, end: range.end, word }, text)) {
    return <span>{text}</span>
  }

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
