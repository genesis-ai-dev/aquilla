// Parallel eBible pairs (vref-aligned, same line = same verse) for the
// source-aware BIA eval and tuning. Public-domain / openly licensed texts.
//
// Aquilla's users translate INTO lower-resource languages, so those pairs are
// listed first, are the only ones tuning looks at, and lead every report.
// Spanish→English stays as a secondary, higher-resource reference.
export interface ParallelPair {
  label: string
  source: string
  target: string
  lowResource: boolean
}

export const PARALLEL_PAIRS: readonly ParallelPair[] = [
  { label: "eng→npi (Nepali, Devanagari)", source: "eng-engwebp.txt", target: "npi-npiulb.txt", lowResource: true },
  { label: "eng→tpi (Tok Pisin)", source: "eng-engwebp.txt", target: "tpi-tpi.txt", lowResource: true },
  { label: "eng→quc (K'iche', Mayan; NT)", source: "eng-engwebp.txt", target: "quc-qucNNT.txt", lowResource: true },
  { label: "eng→chk (Chuukese, Austronesian)", source: "eng-engwebp.txt", target: "chk-chk.txt", lowResource: true },
  { label: "spa→eng (English, reference)", source: "spa-spaRV1909.txt", target: "eng-engwebp.txt", lowResource: false },
]

/** Whole Bible (or NT), and the first 2,000 verses (an early project). */
export const SLICES: ReadonlyArray<readonly [string, number | undefined]> = [
  ["full", undefined],
  ["first 2000", 2000],
]
