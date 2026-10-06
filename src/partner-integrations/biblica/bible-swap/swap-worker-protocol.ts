/**
 * Message protocol shared by the Bible Swap worker entry and its client.
 *
 * Codex fanned stories across a `worker_threads` pool sized to the host's CPU
 * count. A browser SPA has no equivalent cheap fork, and the dominant cost is
 * building the Bible verse/chapter indexes once — so Aquilla sends every story
 * in a single request, builds the shared resources one time inside the worker,
 * and streams progress back per story.
 */

import type { BibleSwapMode, SwapStats } from "./types"
import type { SerializedVersificationPlan } from "./language-mappings"

export interface BibleSwapWorkerStory {
  readonly storyKey: string
  readonly studyStoryXml: string
}

export interface BibleSwapWorkerResult {
  readonly storyKey: string
  readonly xml: string
  readonly stats: SwapStats
}

export type BibleSwapWorkerRequest = {
  readonly type: "swap"
  readonly id: string
  readonly bibleStoryXml: string
  readonly swapMode: BibleSwapMode
  readonly stories: readonly BibleSwapWorkerStory[]
  readonly serializedPlan?: SerializedVersificationPlan
  readonly language?: string
  readonly studyVolume?: string
}

export interface BibleSwapWorkerProgress {
  readonly completed: number
  readonly total: number
  readonly storyKey: string
}

export type BibleSwapWorkerResponse =
  | {
      readonly type: "progress"
      readonly id: string
      readonly progress: BibleSwapWorkerProgress
    }
  | {
      readonly type: "success"
      readonly id: string
      readonly results: readonly BibleSwapWorkerResult[]
    }
  | {
      readonly type: "error"
      readonly id: string
      readonly message: string
    }
