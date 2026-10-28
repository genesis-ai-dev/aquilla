// The media view's one 40 px bar. (Media redesign, layout — canvas board 23,
// "Lean chrome: your mix".)
//
// Canvas board 55, option E — two groups. On the left, what the file is and
// its state: the timeline's tools (portaled into the "media-top-tools" slot by
// TimelineEditor, which owns them: Sources — the film first in it — Timing, a
// thin divider, Check), then History. On the right, how you look at it: the
// status ring, the views as icons (the open one labelled), Panels, then ⋯
// last. It replaces two rows: the toolbar row above the view and the
// timeline's own title row.
// The transport left this bar on Oct 27 (Sam): it is the thin strip along the
// bottom of the view now (VoicePlaybackBar's "strip").

import type { ReactNode } from "react"
import { youTubeVideoId } from "@/lib/video/youtube"
import { uiSlotRef } from "@/lib/ui-slots"

/**
 * What to call a linked film on the button: its file's name where the address
 * has one, the folder above a streaming playlist (whose own name is always
 * "master.m3u8"), and the video's id on YouTube.
 */
export function filmLabelFor(url: string, fallback: string): string {
  const yt = youTubeVideoId(url)
  if (yt) return `YouTube ${yt}`
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p))
    let name = parts.at(-1) ?? ""
    if (/^(master|index|playlist)\.m3u8$/i.test(name)) name = parts.at(-2) ?? ""
    // A storage id ("cmkaom6vg0000bca7bh…") names nothing a person would
    // recognise: the file the film belongs to says more.
    if (!name || (/^[a-z0-9_-]{16,}$/i.test(name) && /\d/.test(name) && !/[._ ]/.test(name))) return fallback
    return name
  } catch {
    return fallback
  }
}

export function MediaTopBar({
  afterTools,
  trailing,
}: {
  /** After the timeline's tools, on the left: History (board 55). */
  afterTools?: ReactNode
  /** The status ring, the views, Panels and ⋯ — right-aligned. */
  trailing: ReactNode
}) {
  return (
    <div
      data-testid="media-top-bar"
      className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-2"
    >
      {/* The timeline's tools land here (TimelineEditor portals them):
          Sources, Timing, a divider, Check. */}
      <div ref={uiSlotRef("media-top-tools")} className="flex min-w-0 items-center gap-1.5 overflow-hidden" />
      {afterTools}
      <div className="ms-auto flex shrink-0 items-center gap-1.5">{trailing}</div>
    </div>
  )
}
