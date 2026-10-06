/**
 * Browser-side loader for the precomputed Bible Swap language mappings.
 *
 * The codex original read `{language}/{VOLUME}.mapping.json` with `fs` from a
 * webpack-copied `out/` directory. Aquilla is a browser SPA, so the mapping
 * files are registered as Vite URL assets instead: `import.meta.glob` with
 * `query: "?url"` emits each JSON as a separate hashed file in `dist/assets`
 * and hands us its URL. Only the URL strings are eager — the ~72 MB of mapping
 * JSON is fetched on demand and never enters the main bundle.
 */

import {
  getBibleSwapLanguageStrategy,
  isMappedBibleSwapLanguage,
  isUsableMappingPlan,
  studyVolumeFromFileName,
  type BibleSwapMappingDocument,
  type SerializedVersificationPlan,
} from "./language-mappings"

/** `./language-mappings/portuguese/JOS-EST.mapping.json` → asset URL. */
const MAPPING_URLS = import.meta.glob<string>("./language-mappings/*/*.mapping.json", {
  query: "?url",
  import: "default",
  eager: true,
})

export interface LoadedBibleSwapMapping {
  volume: string
  plan: SerializedVersificationPlan
  language: string
}

/** In-flight and resolved lookups, keyed `${language}|${volume}`. */
const planCache = new Map<string, Promise<SerializedVersificationPlan | null>>()

function mappingUrl(language: string, volume: string): string | undefined {
  return MAPPING_URLS[`./language-mappings/${language}/${volume}.mapping.json`]
}

/** Whether this language ships at least one mapping asset. */
export function hasMappingAssets(language: string): boolean {
  const prefix = `./language-mappings/${language}/`
  return Object.keys(MAPPING_URLS).some((key) => key.startsWith(prefix))
}

async function readMappingDocument(
  language: string,
  volume: string,
): Promise<BibleSwapMappingDocument | null> {
  const url = mappingUrl(language, volume)
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[BibleSwapMappings] ${url} responded ${res.status} ${res.statusText}`)
      return null
    }
    return (await res.json()) as BibleSwapMappingDocument
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[BibleSwapMappings] Failed to read ${url}: ${detail}`)
    return null
  }
}

/**
 * Mirrors the codex loader's gate: a missing plan, a volume the language
 * strategy marks unusable, or a projected match below the strategy's floor all
 * fall back to analyze-at-export rather than shipping a bad swap.
 */
function usablePlanFrom(
  language: string,
  volume: string,
  doc: BibleSwapMappingDocument | null,
): SerializedVersificationPlan | null {
  if (!doc?.plan) {
    console.warn(
      `[BibleSwapMappings] No mapping found for language "${language}", volume "${volume}" — falling back to analyze-at-export.`,
    )
    return null
  }

  const strategy = getBibleSwapLanguageStrategy(language)
  const projected =
    doc.versificationSummary?.projectedVerseMatchPercent ??
    (doc.plan.stats.versesMapped > 0 ? undefined : 0)

  if (!isUsableMappingPlan(strategy, volume, doc.plan, projected)) {
    const replaceCount = doc.plan.verseMappings.filter((m) => m.action === "replace").length
    console.warn(
      `[BibleSwapMappings] Mapping for ${language}/${volume} is marked unusable ` +
        `(projectedMatch=${projected ?? "n/a"}, replaceCount=${replaceCount}) — ` +
        `falling back to analyze-at-export.`,
    )
    return null
  }

  return doc.plan
}

/**
 * Load the precomputed versification plan for a language + study volume
 * (volume comes from the study file name, e.g. `JOS-EST.idml` → `JOS-EST`).
 * Resolves to null when the language is "any"/unknown, the volume is marked
 * unusable on the language strategy, or no usable mapping asset exists.
 */
export async function loadBibleSwapMappingPlan(
  language: string | undefined,
  studyFileName: string,
): Promise<LoadedBibleSwapMapping | null> {
  if (!language || !isMappedBibleSwapLanguage(language)) return null

  const volume = studyVolumeFromFileName(studyFileName)
  const cacheKey = `${language}|${volume}`

  let pending = planCache.get(cacheKey)
  if (!pending) {
    pending = readMappingDocument(language, volume).then((doc) =>
      usablePlanFrom(language, volume, doc),
    )
    planCache.set(cacheKey, pending)
  }

  const plan = await pending
  return plan ? { volume, plan, language } : null
}

/** Test seam — mapping assets are immutable in production. */
export function clearBibleSwapMappingCache(): void {
  planCache.clear()
}
