// AQU-1758 (Sam, Oct 29): what picking a chapter in the chapter picker does to
// playback on a book.
//
// Playing (Play all, or a line playing on its way): playback jumps to the
// chapter picked and keeps playing, from its first line, in either timing —
// the same start Play all makes when it carries on into the next chapter. A
// chapter with nothing to play cannot carry it on, so playback stops there.
//
// Paused on another chapter: that playback ends, as it always has, and the
// timeline shows the chapter picked. Picking the chapter that is playing, or
// picking with nothing playing on this file, only shows it.
//
// Scrolling the table onto another chapter is not a pick. It names the chapter
// on screen and nothing more: a paused playback waits to be resumed where it
// was, and the timeline stays on its chapter meanwhile. A row of another
// chapter clicked is a pick of its own kind (`rowEndsPlayback`).

import type { CellData } from "@/hooks/useCells"
import {
  hasAnyPlayableAudio,
  startQueue,
  stopQueue,
  type PlayContext,
  type QueueState,
} from "@/lib/audio/play-queue"
import { scopeCells, type TimelineChapter } from "./sequence-timeline"

export type ChapterPickPlan =
  | { kind: "show" }
  | { kind: "stop" }
  | { kind: "play"; chapter: TimelineChapter }

export function planChapterPick({
  chapters,
  lines,
  pickedKey,
  playingKey,
  queueKind,
}: {
  chapters: readonly TimelineChapter[]
  /** The lines the book's timeline may draw, before any chapter. */
  lines: readonly CellData[]
  pickedKey: string
  /** The chapter playback is on in this file, or null. */
  playingKey: string | null
  queueKind: QueueState["kind"]
}): ChapterPickPlan {
  if (!playingKey || playingKey === pickedKey) return { kind: "show" }
  if (queueKind !== "playing" && queueKind !== "loading") return { kind: "stop" }
  const chapter = chapters.find((c) => c.key === pickedKey)
  if (!chapter || !hasAnyPlayableAudio(scopeCells(lines, chapter))) return { kind: "stop" }
  return { kind: "play", chapter }
}

/** Carry the plan out. True when playback goes to the chapter picked. */
export function applyChapterPick(
  plan: ChapterPickPlan,
  run: { lines: readonly CellData[]; projectId: string | undefined; session: PlayContext["session"] | null | undefined },
): boolean {
  if (plan.kind === "show") return false
  if (plan.kind === "play" && run.projectId && run.session) {
    startQueue({ cells: scopeCells(run.lines, plan.chapter), projectId: run.projectId, session: run.session }, 0)
    return true
  }
  stopQueue()
  return false
}

/**
 * A row of another chapter clicked — it points the timeline at its line —
 * while playback is paused on this file: that playback ends, as a pick ends
 * it, so the timeline can show the row's chapter. A row of the chapter
 * playing, or a click while playback plays, leaves playback alone.
 */
export function rowEndsPlayback({
  rowKey,
  playingKey,
  queueKind,
}: {
  rowKey: string
  /** The chapter playback is on in this file, or null. */
  playingKey: string | null
  queueKind: QueueState["kind"]
}): boolean {
  return playingKey != null && rowKey !== playingKey && queueKind === "paused"
}
