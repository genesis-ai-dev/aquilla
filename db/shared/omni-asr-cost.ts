/** Omnilingual ASR (self-hosted on Modal) is billed by metered GPU time, not a
 * provider price list: rawCents = gpuSeconds × rate[gpu] × amortization. The
 * usual credit markup (billing-cost.ts costMultiplier) applies on top.
 *
 * Rates are Modal's per-second GPU prices in US cents. CHECK THEM AGAINST
 * https://modal.com/pricing AT DEPLOY TIME — they are not fetched.
 */
/** Keyed on the CUDA device name the service reports as `gpu`. */
export const OMNI_GPU_CENTS_PER_SEC: Readonly<Record<string, number>> = {
  'NVIDIA L4': 0.0222,
  'NVIDIA L40S': 0.0542,
}
/** An unrecognised GPU name (Modal moved the class, or a new card) bills at
 * the dearest known rate: overcharging is fixable, a free GPU is not. */
export const OMNI_FALLBACK_CENTS_PER_SEC = Math.max(...Object.values(OMNI_GPU_CENTS_PER_SEC))

export function omniGpuCentsPerSec(gpu: string): number {
  return Object.prototype.hasOwnProperty.call(OMNI_GPU_CENTS_PER_SEC, gpu)
    ? OMNI_GPU_CENTS_PER_SEC[gpu] : OMNI_FALLBACK_CENTS_PER_SEC
}

export type OmniModel = 'ctc' | 'zs'

/** GPU each model runs on, for the admission bound (spec §8). */
export const OMNI_MODEL_GPU: Record<OmniModel, string> = { ctc: 'NVIDIA L4', zs: 'NVIDIA L40S' }

/** GPU-seconds per audio-second used only for the reservation bound. The
 * Modal spike measured ≈0.09 (CTC) and 0.3–0.45 (ZS, 10 examples); these leave
 * headroom. Settlement uses the measured time. */
export const OMNI_MAX_RTF: Record<OmniModel, number> = { ctc: 0.5, zs: 2 }

/** Fixed seconds added to the bound for model load and example fetches. */
export const OMNI_BOUND_OVERHEAD_SEC = 30

/** Covers idle scaledown time and cold starts that no single call is billed for. */
export const OMNI_DEFAULT_AMORTIZATION = 1.5

export function omniAmortization(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return OMNI_DEFAULT_AMORTIZATION
  const value = Number(raw)
  // A typo must not make the service free or negative: fail loud instead.
  if (!Number.isFinite(value) || value < 1) throw new Error('OMNI_ASR_AMORTIZATION must be a number >= 1')
  return value
}

/** The reservation ceiling for one call: assume the slowest plausible run. */
export function omniCostBoundCents(model: OmniModel, audioSeconds: number, amortization: number): number {
  const rate = omniGpuCentsPerSec(OMNI_MODEL_GPU[model])
  const seconds = Math.ceil(audioSeconds * OMNI_MAX_RTF[model] + OMNI_BOUND_OVERHEAD_SEC)
  return seconds * rate * amortization
}

/** Smallest charge for a call that ran. A measured 0 s is a timer artefact,
 * not a free GPU, and settling zero would read as "proven free". */
export const OMNI_MIN_GPU_SECONDS = 0.01

/** Actual cost from the GPU time the service measured. Never zero. */
export function omniRawCostCents(gpuSeconds: number, gpu: string, amortization: number): number {
  if (!Number.isFinite(gpuSeconds) || gpuSeconds < 0) throw new Error('GPU seconds must be a known nonnegative amount')
  return Math.max(gpuSeconds, OMNI_MIN_GPU_SECONDS) * omniGpuCentsPerSec(gpu) * amortization
}
