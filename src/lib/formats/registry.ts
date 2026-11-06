// Extension → filter (AQU-2384).
//
// The TABLE lives in `./descriptors.ts` (pure, shared by the browser, the
// parse Web Worker and the sync-worker). This module binds each descriptor to
// its implementation, which means it is allowed to reach into the DOM-bound
// parsers — so it must never be imported by a Worker. The binding is a THUNK
// per format, not a static import, for the same reason the partner registry's
// heavy work hangs off a thunk: looking up what formats exist must not pull
// seven parsers and two zip libraries into the bundle that asked the question.
//
// Every id in the table must have exactly one binding and vice versa, and
// `./registry.test.ts` asserts it — a descriptor with no implementation is a
// format the UI would offer and then fail to open.

import type { CellData } from "@/hooks/useCells"
import { partnerIntegrations } from "@/lib/partners/registry"
import type { PartnerIntegration } from "@/lib/partners/types"
import type { PartnerFormatFilterRegistration } from "./partner-contract"
import type { FormatFilter } from "./contract"
import {
  FORMAT_DESCRIPTORS,
  descriptorForExtension,
  extensionOfFileName,
  normalizeExtension,
  type FormatDescriptor,
} from "./descriptors"

export type FormatFilterLoader = () => Promise<FormatFilter<CellData>>

/**
 * id → how to load that format's filter. Code-split on purpose: a caller that
 * only needs to know whether `.idml` is importable never loads the IDML engine.
 */
const LOADERS: Readonly<Record<string, FormatFilterLoader>> = {
  docx: async () => (await import("./filters/docx")).docxFilter,
  pptx: async () => (await import("./filters/pptx")).pptxFilter,
  idml: async () => (await import("./filters/idml")).idmlFilter,
  html: async () => (await import("./filters/html")).htmlFilter,
  xliff: async () => (await import("./filters/xliff")).xliffFilter,
  srt: async () => (await import("./filters/subtitle")).srtFilter,
  vtt: async () => (await import("./filters/subtitle")).vttFilter,
}

/** The ids the table declares — the set the UI may offer. */
export function registeredFormatIds(): readonly string[] {
  return FORMAT_DESCRIPTORS.map((descriptor) => descriptor.id)
}

/** The ids this module can actually load. Equal to the above, by test. */
export function boundFormatIds(): readonly string[] {
  return Object.keys(LOADERS).sort()
}

export function loaderForFormatId(id: string): FormatFilterLoader | undefined {
  return LOADERS[id]
}

/**
 * Load the filter for one extension (with or without a leading dot), or
 * undefined when no registered format claims it. Undefined is the ordinary
 * answer for most files — the formats not yet wrapped (usfm, md, csv, …) are
 * still imported by their own parsers through `../import.ts`, so a miss here
 * means "not on the contract yet", never "unsupported".
 */
export async function filterForExtension(
  extension: string,
): Promise<FormatFilter<CellData> | undefined> {
  const descriptor = descriptorForExtension(extension)
  if (descriptor) return LOADERS[descriptor.id]?.()
  return partnerFiltersFrom(partnerIntegrations()).get(normalizeExtension(extension))?.load()
}

export async function filterForFileName(
  fileName: string,
): Promise<FormatFilter<CellData> | undefined> {
  return filterForExtension(extensionOfFileName(fileName))
}

export async function filterForFormatId(
  id: string,
): Promise<FormatFilter<CellData> | undefined> {
  return LOADERS[id]?.()
}

/**
 * Partner-registered filters, keyed by extension.
 *
 * Derived from `partnerIntegrations()` — never a static import of a partner
 * module — which is the AQU-1286 seam restated for formats: with the partner
 * folders deleted the glob matches nothing, this map is empty, and every
 * caller behaves as though those formats were never offered.
 *
 * Split from the live glob so the stripped case is directly testable: no real
 * glob can be made to match nothing, but `partnerFiltersFrom([])` is exactly
 * what the public copy sees.
 *
 * A partner may not take over an extension a generic format already claims —
 * silently shadowing `.docx` with a publisher's walk would change what every
 * project imports, so the generic entry wins and the clash is reported.
 */
export function partnerFiltersFrom(
  integrations: readonly PartnerIntegration[],
): ReadonlyMap<string, PartnerFormatFilterRegistration> {
  const byExtension = new Map<string, PartnerFormatFilterRegistration>()
  for (const integration of integrations) {
    for (const registration of integration.formatFilters ?? []) {
      for (const raw of registration.descriptor.extensions) {
        const extension = normalizeExtension(raw)
        if (descriptorForExtension(extension)) continue
        if (byExtension.has(extension)) continue
        byExtension.set(extension, registration)
      }
    }
  }
  return byExtension
}

/** Extensions only a partner claims. Empty in the public copy. */
export function partnerFormatExtensionsFrom(
  integrations: readonly PartnerIntegration[],
): readonly string[] {
  return [...partnerFiltersFrom(integrations).keys()].sort()
}

export function partnerFormatExtensions(): readonly string[] {
  return partnerFormatExtensionsFrom(partnerIntegrations())
}

export type { FormatDescriptor }
