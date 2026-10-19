// Before a zero-shot BATCH (spec §5, "Batch"): say what share of the week's
// remaining credits it should use, and let the person run it, run it with the
// automatic model, or stop. A single run shows no price — only batches ask.

import { getOrgCredits } from "@/lib/sync/credits"
import { formatCredits } from "@/lib/credits"
import { t } from "@/lib/i18n/standalone"
import type { CellData } from "@/hooks/useCells"
import { DEFAULT_CREDIT_MARKUP, estimateZeroShotCredits, shareOfRemainingCredits } from "./omni-cost-estimate"
import { fetchZsStatus } from "./omni-warmup"

/** A take whose length is not known yet is counted as a full ZS window. */
const UNKNOWN_TAKE_SEC = 30

/** Seconds of audio the batch will send: each take's kept part. */
export function batchAudioSeconds(cells: readonly CellData[]): number {
  let total = 0
  for (const cell of cells) {
    const attachment = cell.selectedAudioId ? cell.attachments?.[cell.selectedAudioId] : undefined
    const endMs = attachment?.trimEndMs ?? attachment?.durationMs
    const startMs = attachment?.trimStartMs ?? 0
    total += endMs != null && endMs > startMs ? (endMs - startMs) / 1000 : UNKNOWN_TAKE_SEC
  }
  return total
}

/**
 * "≈ 12% of this week's remaining credits", or "≈ 40 credits" when the
 * reader may not see the org's balance (the credits endpoint 403s) or there is
 * no balance left to measure against.
 */
export async function zeroShotBatchCostLine(args: {
  jwt: string
  projectId: string
  orgId?: number | null
  audioSec: number
}): Promise<string> {
  const [status, credits] = await Promise.all([
    fetchZsStatus(args.jwt, args.projectId).catch(() => null),
    args.orgId != null ? getOrgCredits(args.jwt, args.orgId).catch(() => null) : Promise.resolve(null),
  ])
  const estimate = estimateZeroShotCredits(
    args.audioSec,
    status?.estGpuSecPerAudioSec,
    credits?.config.markup ?? DEFAULT_CREDIT_MARKUP,
  )
  const percent = credits ? shareOfRemainingCredits(estimate, credits.remaining.weekly) : null
  return percent != null
    ? t("settings.transcription.zeroShot.batchShare", { percent })
    : t("settings.transcription.zeroShot.batchCredits", { credits: formatCredits(estimate) })
}
