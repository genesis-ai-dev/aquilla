// AQU-1758 (Sam, Oct 29): what picking a chapter in the chapter picker does to
// playback on a book.
//
// Playing (Play all, or a line playing on its way): playback jumps to the
// chapter picked and keeps playing, from its first line, in either timing —
// the same start Play all makes when it carries on into the next chapter. A
// chapter with nothing to play cannot carry it on, so playback stops there.
// (AQU-2253: following the recordings, a linked film behind a chapter's lines
// is something to play for a pick, as for the strip's Play. Nov 12: a pick
// asks the queue's own answer, `linesPlaybackStopsAt`, so with "Skip lines
// with nothing to play" off a chapter nobody has recorded is played through
// in silence, as Play plays it.)
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
  linesHaveAnythingOfTheirOwnToPlay,
  linesPlaybackStopsAt,
  startQueue,
  stopQueue,
  type PlayContext,
  type PlaybackAsk,
  type QueueState,
} from "@/lib/audio/play-queue"
import { nextPlayableChapter, scopeCells, type TimelineChapter } from "./sequence-timeline"

/**
 * AQU-2253 (review 2, Nov 9): where Play all goes when a run of one chapter
 * plays out (ProjectWorkspace's `onQueueRanOut`): the next chapter with
 * something of its OWN to play, a take or an original, or null, and Play all
 * ends there. A linked film behind a chapter does not count here: this move
 * is made only by a run that does not already hold the later chapters (a run
 * of the whole-book timeline plays them itself), one on its own clock from
 * 0:00, where the film behind a chapter nobody has recorded is only the
 * film's opening again. (A chapter picked by
 * hand counts the film, `planChapterPick`; play-queue's "anything to play"
 * questions say which caller asks which and why.)
 */
export function nextChapterForPlayAll({
  chapters,
  lines,
  playedKey,
}: {
  chapters: readonly TimelineChapter[]
  /** The lines the book's timeline may draw, before any chapter. */
  lines: readonly CellData[]
  /** The chapter whose run just played out. */
  playedKey: string
}): TimelineChapter | null {
  return nextPlayableChapter(chapters, playedKey, (chapter) => linesHaveAnythingOfTheirOwnToPlay(scopeCells(lines, chapter)))
}

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
  ask,
}: {
  chapters: readonly TimelineChapter[]
  /** The lines the book's timeline may draw, before any chapter. */
  lines: readonly CellData[]
  pickedKey: string
  /** The chapter playback is on in this file, or null. */
  playingKey: string | null
  queueKind: QueueState["kind"]
  /** What the queue's answer turns on (its timing, tracks, film, Skip). */
  ask: PlaybackAsk
}): ChapterPickPlan {
  if (!playingKey || playingKey === pickedKey) return { kind: "show" }
  if (queueKind !== "playing" && queueKind !== "loading") return { kind: "stop" }
  const chapter = chapters.find((c) => c.key === pickedKey)
  // AQU-2253 (review 2, Nov 9): a pick is someone asking for that chapter, so
  // it asks what pressing Play on it asks: the lines the queue stops at
  // (a take, an original, a linked film behind them, or, with Skip off, any
  // line). Play all's own move asks for the chapter's own.
  if (!chapter || linesPlaybackStopsAt(scopeCells(lines, chapter), ask).size === 0) return { kind: "stop" }
  return { kind: "play", chapter }
}

/** Carry the plan out. True when playback goes to the chapter picked. */
export function applyChapterPick(
  plan: ChapterPickPlan,
  run: { lines: readonly CellData[]; projectId: string | undefined; session: PlayContext["session"] | null | undefined },
): boolean {
  if (plan.kind === "show") return false
  if (plan.kind === "play" && run.projectId && run.session) {
    // The timeline is the whole book, so the run is the whole book too.
    // Starting at this chapter's first line keeps the playhead on the same
    // seconds the timeline drew.
    const firstId = scopeCells(run.lines, plan.chapter)[0]?.id
    const at = firstId == null ? -1 : run.lines.findIndex((cell) => cell.id === firstId)
    startQueue(
      { cells: [...run.lines], projectId: run.projectId, session: run.session },
      at < 0 ? 0 : at,
    )
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
