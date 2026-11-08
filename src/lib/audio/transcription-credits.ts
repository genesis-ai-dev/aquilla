// AQU-2426: the Credits line of what transcribing will cost (board 58, open
// detail "Should the cost also show credits?" — yes, a fifth line, "About N
// credits, X% of this week's remaining", from the estimate the zero-shot batch
// already asks the server for). It also hands back the org's credits, which
// say whether the organization can pay at all (transcribe-access.ts).
//
// Nothing is spent finding out: `/status` and the credits read are free. A
// reader who may not see the org's balance (the credits endpoint 403s) gets
// the credits alone; anything that can't be read leaves the line out.

import { getOrgCredits, type OrgCredits } from "@/lib/sync/credits"
import { DEFAULT_CREDIT_MARKUP, estimateZeroShotCredits, shareOfRemainingCredits } from "./omni-cost-estimate"
import { fetchZsStatus } from "./omni-warmup"

export interface TranscriptionCredits {
  credits: number
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
}): Promise<TranscriptionCredits> {
  const [status, orgCredits] = await Promise.all([
    fetchZsStatus(args.jwt, args.projectId).catch(() => null),
    args.orgId != null ? getOrgCredits(args.jwt, args.orgId).catch(() => null) : Promise.resolve(null),
  ])
  const credits = estimateZeroShotCredits(
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
