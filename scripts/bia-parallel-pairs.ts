// Parallel eBible pairs (vref-aligned, same line = same verse) for the
// source-aware BIA eval and tuning. Public-domain / openly licensed texts.
export const PARALLEL_PAIRS = [
  { label: "eng→npi (Nepali)", source: "eng-engwebp.txt", target: "npi-npiulb.txt" },
  { label: "eng→tpi (Tok Pisin)", source: "eng-engwebp.txt", target: "tpi-tpi.txt" },
  { label: "spa→eng (English)", source: "spa-spaRV1909.txt", target: "eng-engwebp.txt" },
] as const

/** Whole Bible, and the first 2,000 verses (an early project). */
export const SLICES: ReadonlyArray<readonly [string, number | undefined]> = [
  ["full", undefined],
  ["first 2000", 2000],
]
