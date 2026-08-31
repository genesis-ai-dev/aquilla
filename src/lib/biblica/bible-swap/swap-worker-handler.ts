/**
 * Runtime-neutral handler behind the Bible Swap worker entry.
 *
 * Kept separate from `swap.worker.ts` so the protocol can be exercised in tests
 * without a live `Worker` — the entry file only wires this to `postMessage`.
 */

import {
  applyBibleSwapWithShared,
  buildBibleSwapSharedResources,
  deserializeVersificationPlan,
} from "./index"
import type {
  BibleSwapWorkerRequest,
  BibleSwapWorkerResponse,
  BibleSwapWorkerResult,
} from "./swap-worker-protocol"

/**
 * Run one swap request, emitting a progress response per completed story and a
 * single terminal success/error response.
 */
export function handleBibleSwapRequest(
  request: BibleSwapWorkerRequest,
  post: (response: BibleSwapWorkerResponse) => void,
): void {
  const { id, bibleStoryXml, swapMode, stories, serializedPlan, language, studyVolume } = request

  try {
    // Indexing the Bible dominates the cost, so do it once for all stories.
    const shared = buildBibleSwapSharedResources(bibleStoryXml, swapMode, language)
    const versificationPlan = serializedPlan
      ? deserializeVersificationPlan(serializedPlan)
      : undefined

    const results: BibleSwapWorkerResult[] = []
    for (const story of stories) {
      const { xml, stats } = applyBibleSwapWithShared(
        story.studyStoryXml,
        bibleStoryXml,
        swapMode,
        shared,
        { versificationPlan, language, studyVolume },
      )
      results.push({ storyKey: story.storyKey, xml, stats })
      post({
        type: "progress",
        id,
        progress: { completed: results.length, total: stories.length, storyKey: story.storyKey },
      })
    }

    post({ type: "success", id, results })
  } catch (error) {
    post({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
