// ESTIMATES ONLY, mirrored by hand from the auth-worker's Omnilingual billing
// (Omnilingual ASR spec §3). The server bills the GPU time a run really used;
// these numbers only size a zero-shot BATCH before it starts, so the user can
// see roughly what share of the week's credits it will take. When the server's
// rates, amortization or markup change, change them here too.

import { creditsFor } from "@/lib/credits"

/** GPU price per second, in cents (server: OMNI_GPU_CENTS_PER_SEC). */
export const OMNI_GPU_CENTS_PER_SEC = { L4: 0.0222, L40S: 0.0542, A100_80: 0.0694 } as const
/** The GPU the zero-shot model starts on (spec §1). */
export const ZS_GPU: keyof typeof OMNI_GPU_CENTS_PER_SEC = "L40S"
/** Server env OMNI_ASR_AMORTIZATION's default: idle scaledown and cold starts. */
export const OMNI_ASR_AMORTIZATION = 1.5
/** The credit markup when the org's own config is not readable. */
export const DEFAULT_CREDIT_MARKUP = 4
/**
 * GPU-seconds per audio-second when `/status` does not say. The server owns
 * the real figure (`estGpuSecPerAudioSec`); this is upstream's A100 RTF
 * (0.194) rounded up for the slower L40S.
 */
export const ZS_EST_GPU_SEC_PER_AUDIO_SEC_FALLBACK = 0.25

/** Credits a zero-shot run over `audioSec` seconds of audio should cost. */
export function estimateZeroShotCredits(
  audioSec: number,
  gpuSecPerAudioSec: number = ZS_EST_GPU_SEC_PER_AUDIO_SEC_FALLBACK,
  markup: number = DEFAULT_CREDIT_MARKUP,
): number {
  const rawCents = audioSec * gpuSecPerAudioSec * OMNI_GPU_CENTS_PER_SEC[ZS_GPU] * OMNI_ASR_AMORTIZATION
  return creditsFor(rawCents, "llm", { markup, agentMarkup: markup })
}

/**
 * The estimate as a whole percentage of the credits left, or null when there
 * is no positive balance to measure against (the caller then shows credits).
 */
export function shareOfRemainingCredits(credits: number, remaining: number): number | null {
  if (!(remaining > 0)) return null
  return Math.ceil((credits / remaining) * 100)
}
