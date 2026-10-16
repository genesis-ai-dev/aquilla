/** Omnilingual ASR (self-hosted on Modal) is billed by metered GPU time, not a
 * provider price list: rawCents = gpuSeconds × rate[gpu] × amortization. The
 * usual credit markup (billing-cost.ts costMultiplier) applies on top.
 *
 * Rates are Modal's per-second GPU prices in US cents. CHECK THEM AGAINST
 * https://modal.com/pricing AT DEPLOY TIME — they are not fetched.
 */
export const OMNI_GPU_CENTS_PER_SEC = {
  L4: 0.0222,
  L40S: 0.0542,
  A100_80: 0.0694,
} as const
export type OmniGpu = keyof typeof OMNI_GPU_CENTS_PER_SEC
export const OMNI_GPUS = ['L4', 'L40S', 'A100_80'] as const satisfies readonly OmniGpu[]

export type OmniModel = 'ctc' | 'zs'

/** GPU each model runs on, for the admission bound (spec §1). */
export const OMNI_MODEL_GPU: Record<OmniModel, OmniGpu> = { ctc: 'L4', zs: 'L40S' }

/** Worst-case real-time factor used only for the reservation bound. Upstream
 * reports 0.002 (CTC) and 0.194 (ZS) on an A100; these leave headroom for
 * slower GPUs and 10 context examples. Settlement uses the measured time. */
export const OMNI_MAX_RTF: Record<OmniModel, number> = { ctc: 0.1, zs: 1 }

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
  const gpu = OMNI_MODEL_GPU[model]
  // The ZS class may be moved to an A100 after benchmarking (spec §1); bound
  // at the dearer of the two so that move cannot under-reserve.
  const rate = model === 'zs'
    ? Math.max(OMNI_GPU_CENTS_PER_SEC.L40S, OMNI_GPU_CENTS_PER_SEC.A100_80)
    : OMNI_GPU_CENTS_PER_SEC[gpu]
  const seconds = Math.ceil(audioSeconds * OMNI_MAX_RTF[model] + OMNI_BOUND_OVERHEAD_SEC)
  return seconds * rate * amortization
}

/** Smallest charge for a call that ran. A measured 0 s is a timer artefact,
 * not a free GPU, and settling zero would read as "proven free". */
export const OMNI_MIN_GPU_SECONDS = 0.01

/** Actual cost from the GPU time the service measured. Never zero. */
export function omniRawCostCents(gpuSeconds: number, gpu: OmniGpu, amortization: number): number {
  if (!Number.isFinite(gpuSeconds) || gpuSeconds < 0) throw new Error('GPU seconds must be a known nonnegative amount')
  return Math.max(gpuSeconds, OMNI_MIN_GPU_SECONDS) * OMNI_GPU_CENTS_PER_SEC[gpu] * amortization
}
