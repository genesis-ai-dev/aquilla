// AQU-2426: the Credits line of what transcribing will cost (board 58, open
// detail "Should the cost also show credits?" — yes, a fifth line, "About N
// credits, X% of this week's remaining"). It also hands back the org's
// credits, which say whether the organization can pay at all
// (transcribe-access.ts).
//
// AQU-2426 (review, Nov 9): the figure is for the model the recording will
// really go to (`resolveSourceModel`), or there is none. It used to be worked
// out as a zero-shot run whatever the model, which for Whisper read some 50
// times too high (about 500 credits for a 52-minute recording that costs
// about 10).
//   • Omnilingual (CTC) is billed by GPU time, at rates mirrored here
//     (omni-cost-estimate.ts) and a speed the server reports: estimated.
//   • Whisper and Qwen are billed by the audio second at a price the server
//     reads live from the provider. Nothing here knows it, so no figure is
//     given and the line is left out; a wrong number is worse than none.
//
// Nothing is spent finding out: `/status` and the credits read are free. A
// reader who may not see the org's balance (the credits endpoint 403s) gets
// the credits alone; anything that can't be read leaves the line out.

import { getOrgCredits, type OrgCredits } from "@/lib/sync/credits"
import { DEFAULT_CREDIT_MARKUP, estimateCtcCredits, shareOfRemainingCredits } from "./omni-cost-estimate"
import { fetchOmniStatus } from "./omni-warmup"
import type { SourceModel } from "./transcription-cost"

export interface TranscriptionCredits {
  /** About how many credits, or null when this model's price isn't known here. */
  credits: number | null
  /** Share of this week's remaining, or null when it can't be measured. */
  percent: number | null
  /** The org's credits, when this person may read them. */
  orgCredits: OrgCredits | null
}

export async function transcriptionCredits(args: {
  jwt: string
  projectId: string
  orgId?: number | null
  audioSec: number
  /** The model the recording will be sent to. */
  model: SourceModel
}): Promise<TranscriptionCredits> {
  const omni = args.model === "omni-ctc"
  const [status, orgCredits] = await Promise.all([
    omni ? fetchOmniStatus(args.jwt, args.projectId, "ctc").catch(() => null) : Promise.resolve(null),
    args.orgId != null ? getOrgCredits(args.jwt, args.orgId).catch(() => null) : Promise.resolve(null),
  ])
  if (!omni) return { credits: null, percent: null, orgCredits }
  const credits = estimateCtcCredits(
    args.audioSec,
    status?.estGpuSecPerAudioSec,
    orgCredits?.config.markup ?? DEFAULT_CREDIT_MARKUP,
  )
  return {
    credits,
    percent: orgCredits ? shareOfRemainingCredits(credits, orgCredits.remaining.weekly) : null,
    orgCredits,
  }
}
