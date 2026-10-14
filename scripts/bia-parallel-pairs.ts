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

/**
 * Language-agnosticism checks (never tuning targets): scripts written without
 * spaces between words, and highly agglutinative / polysynthetic targets.
 * Same English source as the low-resource pairs.
 */
export const AGNOSTIC_PAIRS: readonly ParallelPair[] = [
  { label: "eng→tha (Thai, no spaces)", source: "eng-engwebp.txt", target: "tha-thaKJV.txt", lowResource: false },
  { label: "eng→mya (Burmese, no spaces)", source: "eng-engwebp.txt", target: "mya-mya.txt", lowResource: false },
  { label: "eng→jpn (Japanese, no spaces; NT)", source: "eng-engwebp.txt", target: "jpn-jpn1965.txt", lowResource: false },
  { label: "eng→qub (Quechua, agglutinative)", source: "eng-engwebp.txt", target: "qub-qub.txt", lowResource: false },
  { label: "eng→esk (Inupiatun, polysynthetic; NT)", source: "eng-engwebp.txt", target: "esk-eskNT.txt", lowResource: false },
  { label: "eng→tur (Turkish, agglutinative)", source: "eng-engwebp.txt", target: "tur-turytc.txt", lowResource: false },
]
