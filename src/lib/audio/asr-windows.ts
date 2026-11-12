// Where to cut a clip into hosted requests (spec §5, "Windowing"). Whisper and
// Qwen take fixed one-minute windows. Omnilingual must stay under 40 s and ZS
// learned on 30 s clips, so its windows are at most 30 s — and each cut goes at
// the quietest moment near the boundary, so a word is not split across two
// requests (each of which would then mishear half of it).

const SAMPLE_RATE = 16000
/** How far back from the 30 s mark a cut may move to find a pause. */
const SEARCH_SEC = 5
/** Loudness is compared over 20 ms frames. */
const FRAME = SAMPLE_RATE / 50

/** Start offsets (in samples) of each window, first always 0. */
export function windowStarts(pcm: Float32Array, maxSec: number, splitAtQuiet: boolean): number[] {
  const max = maxSec * SAMPLE_RATE
  const starts = [0]
  let start = 0
  while (pcm.length - start > max) {
    const end = start + max
    const cut = splitAtQuiet ? quietestFrame(pcm, Math.max(start + FRAME, end - SEARCH_SEC * SAMPLE_RATE), end) : end
    starts.push(cut)
    start = cut
  }
  return starts
}

/** The start of the lowest-energy frame in [from, to), never past `to`. */
function quietestFrame(pcm: Float32Array, from: number, to: number): number {
  let best = to
  let bestEnergy = Infinity
  for (let frame = from; frame + FRAME <= to; frame += FRAME) {
    let energy = 0
    for (let i = frame; i < frame + FRAME; i++) energy += pcm[i] * pcm[i]
    // `<=` keeps the LATEST of equally quiet frames, so silence still gives
    // the longest window and the fewest requests.
    if (energy <= bestEnergy) {
      bestEnergy = energy
      best = frame
    }
  }
  return best
}
