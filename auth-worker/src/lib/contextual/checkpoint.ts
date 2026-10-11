// AQU-1845 — the wave's model-call checkpoint, as an LlmCall decorator.
//
// `runOneTick` advances the run cursor past a wave in ONE guarded write
// (tick.ts), so a driver that dies mid-wave replays that entire wave on its
// next attempt. Each span is several sequential model calls, and before this
// decorator the replay re-issued every one of them — including the calls the
// dead attempt had already finished and paid for, whose output was simply
// discarded. That is the "calls whose output is discarded have already been
// paid for" half of AQU-1845.
//
// The decorator sits OUTSIDE makeLlmCall, which is what makes a replay free:
// a checkpoint hit never reaches the usage admission, the cost meter, the
// trace recorder or the provider, because the original call already went
// through all four.
//
// Scope: ONE attempt of ONE wave. Build a fresh decorator per wave (the
// driver does) so the occurrence counter — which disambiguates a node that
// issues the same prompt twice — restarts in step with the replay. The driver
// clears a run's checkpoints after every wave that completed, so the rows a
// decorator can ever read are the ones its own predecessor wrote.

import {
  clearContextualRunSteps,
  contextualPromptHash,
  contextualStepKey,
  readContextualRunStep,
  writeContextualRunStep,
  CONTEXTUAL_RUN_STEP_MAX_OUTPUT_CHARS,
} from "../../../../db/shared/contextual-run-steps"
import type { AquillaDb } from "../../../../db/shim/postgres"
import type { LlmCall } from "./types"

export interface CheckpointedLlm {
  llm: LlmCall
  /** Replies served from a checkpoint instead of the provider. The driver
   *  logs this so a resumed run's savings are visible. */
  readonly reused: number
}

/**
 * Wrap `base` so every reply is checkpointed and every replay reads it back.
 *
 * Failure is never fatal: a checkpoint table that is unreachable (or a
 * deployment running ahead of its migration) degrades to calling the provider,
 * exactly as before. The checkpoint is a cost optimisation on the replay path
 * — it must never become a new way for a translation run to fail.
 */
export function checkpointedLlm(
  db: AquillaDb,
  run: { runId: string; projectId: string },
  base: LlmCall,
): CheckpointedLlm {
  const { runId, projectId } = run
  // Occurrences of each otherwise-identical call within THIS attempt. A
  // redraft loop that re-sends an unchanged prompt must get its own
  // checkpoint for the second call rather than reading back the first reply.
  const seen = new Map<string, number>()
  const state = { reused: 0 }

  const llm: LlmCall = async (req) => {
    const identity = {
      spanId: req.spanId ?? "",
      label: req.label ?? "",
      tier: String(req.tier),
      promptHash: contextualPromptHash({
        system: req.system,
        user: req.user,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
      }),
      occurrence: 0,
    }
    // Reserve the occurrence BEFORE awaiting anything: two concurrent spans
    // never share a key (spanId is in it), but a single node that fires the
    // same prompt twice without awaiting between must still get 0 and 1.
    const familyKey = contextualStepKey({ ...identity, occurrence: 0 })
    const occurrence = seen.get(familyKey) ?? 0
    seen.set(familyKey, occurrence + 1)
    const stepKey = contextualStepKey({ ...identity, occurrence })

    try {
      const checkpointed = await readContextualRunStep(db, runId, stepKey)
      if (checkpointed !== null) {
        state.reused += 1
        return checkpointed
      }
    } catch (err) {
      // Read failures mean "no checkpoint", not "stop the run".
      console.warn(`[contextual] checkpoint read failed for run ${runId}:`, err)
    }

    const output = await base(req)

    if (output.length <= CONTEXTUAL_RUN_STEP_MAX_OUTPUT_CHARS) {
      try {
        await writeContextualRunStep(db, runId, projectId, stepKey, output)
      } catch (err) {
        // The call succeeded; losing its checkpoint only costs a replay.
        console.warn(`[contextual] checkpoint write failed for run ${runId}:`, err)
      }
    }
    return output
  }

  return {
    llm,
    get reused() {
      return state.reused
    },
  }
}

/** Drop a run's checkpoints, never throwing. Called after every wave that
 *  completed (its cursor has moved, so those spans will not replay) and when
 *  the run settles. */
export async function discardCheckpoints(db: AquillaDb, runId: string): Promise<void> {
  try {
    await clearContextualRunSteps(db, runId)
  } catch (err) {
    console.warn(`[contextual] checkpoint clear failed for run ${runId}:`, err)
  }
}
