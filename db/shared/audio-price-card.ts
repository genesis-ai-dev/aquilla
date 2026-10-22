// AQU-2065 (unified billing T8, spec §2.2 item 5): price cards for the
// sync-worker audio rails. None of these providers report a cost, so each call
// reserves a bound from the card and settles on what we measured: characters
// sent to Inworld, or GPU seconds a Modal call took.
//
// Raw provider prices in US cents. CHECK THEM AGAINST https://inworld.ai/pricing
// AND https://modal.com/pricing AT DEPLOY TIME — they are not fetched.
import { OMNI_DEFAULT_AMORTIZATION, OMNI_GPU_CENTS_PER_SEC } from './omni-asr-cost'

/** Inworld TTS, cents per input character, keyed on model id. */
export const INWORLD_TTS_CENTS_PER_CHAR: Readonly<Record<string, number>> = {
  'inworld-tts-2-flash': 5 / 1_000_000 * 100, // $5 per 1M characters
  'inworld-tts-2': 10 / 1_000_000 * 100, // $10 per 1M characters
}
/** An unknown model bills at the dearest known rate: overcharging is fixable. */
const INWORLD_FALLBACK_CENTS_PER_CHAR = Math.max(...Object.values(INWORLD_TTS_CENTS_PER_CHAR))

export function inworldTtsRawCents(characters: number, modelId?: string): number {
  if (!Number.isFinite(characters) || characters < 0) throw new Error('TTS characters must be a known nonnegative amount')
  const rate = modelId && Object.prototype.hasOwnProperty.call(INWORLD_TTS_CENTS_PER_CHAR, modelId)
    ? INWORLD_TTS_CENTS_PER_CHAR[modelId] : INWORLD_FALLBACK_CENTS_PER_CHAR
  return characters * rate
}

/** Instant voice clone and voice publish carry no Inworld charge on the card.
 *  They still pass the entitlement check, so the ceiling and allowance gate
 *  them and each one leaves a row. */
export const INWORLD_VOICE_CLONE_CENTS = 0
export const INWORLD_VOICE_PUBLISH_CENTS = 0
/** The ledger refuses a zero reservation, so a free call reserves this and
 *  settles at its card price. */
export const MIN_RESERVATION_CENTS = 0.01

/** Modal GPUs the audio services run on, cents per GPU-second. Omnilingual's
 *  table plus the T4 that diarization runs on. */
export const MODAL_GPU_CENTS_PER_SEC: Readonly<Record<string, number>> = {
  ...OMNI_GPU_CENTS_PER_SEC,
  'NVIDIA T4': 0.0164,
}
/** infra/modal/diarization.py `gpu="T4"`; infra/modal/seed_vc.py runs on L40S. */
export const DIARIZATION_GPU = 'NVIDIA T4'
export const VOICE_CONVERT_GPU = 'NVIDIA L40S'
/** infra/modal/voice_forge.py `convert_audio` (library voices, RVC) runs on L4. */
export const LIBRARY_VOICE_CONVERT_GPU = 'NVIDIA L4'
/** Same idle-scaledown and cold-start allowance as Omnilingual. */
export const MODAL_GPU_AMORTIZATION = OMNI_DEFAULT_AMORTIZATION

/** A measured 0 s is a timer artefact, not a free GPU. */
const MIN_GPU_SECONDS = 0.01

export function modalGpuRawCents(gpu: string, gpuSeconds: number): number {
  if (!Number.isFinite(gpuSeconds) || gpuSeconds < 0) throw new Error('GPU seconds must be a known nonnegative amount')
  const rate = MODAL_GPU_CENTS_PER_SEC[gpu]
  if (rate === undefined) throw new Error(`No price for GPU ${gpu}`)
  return Math.max(gpuSeconds, MIN_GPU_SECONDS) * rate * MODAL_GPU_AMORTIZATION
}
