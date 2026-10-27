/**
 * Partner-integration registry (AQU-1286).
 *
 * Discovery is a Vite glob over `src/partner-integrations/<partner>/register.ts`
 * rather than a list of imports, and that choice is the whole point: a glob that
 * matches nothing is an empty object, not a compile error. Delete the partner
 * folders and `tsc -b`, `vite build` and `vitest` all still pass — the app just
 * stops offering those import options. A static `import "…/biblica/register"`
 * would fail the typecheck the moment the folder went away, which is exactly the
 * coupling this module exists to remove.
 *
 * The glob is eager so the seams that must be synchronous can be: the IDML
 * completion path normalizes html inside a sync function and cannot await a
 * registry. `register.ts` is therefore expected to stay small — descriptors and
 * sync hooks. Everything heavy (parsers, panels) hangs off a thunk on the
 * descriptor (`parse`, `importScreen.panel`) and stays code-split.
 *
 * See `docs/PARTNER-INTEGRATIONS.md` for the convention and how to add one.
 */

import type {
  IdmlTargetHtmlNormalizer,
  PartnerIdmlExportOption,
  PartnerIntegration,
} from "./types"

const registered = import.meta.glob<{ default: PartnerIntegration }>(
  "/src/partner-integrations/*/register.ts",
  { eager: true },
)

/**
 * The derivation, split out from the glob so the *absent* case is directly
 * testable — `integrationsFrom({})` is what the app sees once the partner folders
 * have been stripped, and no test can make a real glob match nothing.
 *
 * Sorted by module path so tile order does not depend on the filesystem's
 * iteration order, and a module without a default export is skipped rather than
 * throwing: a half-written `register.ts` should cost that one integration, not
 * the import dialog.
 */
export function integrationsFrom(
  modules: Readonly<Record<string, { default?: PartnerIntegration } | undefined>>,
): readonly PartnerIntegration[] {
  return Object.keys(modules)
    .sort()
    .map((path) => modules[path]?.default)
    .filter((integration): integration is PartnerIntegration => Boolean(integration))
}

const INTEGRATIONS = integrationsFrom(registered)

export function partnerIntegrations(): readonly PartnerIntegration[] {
  return INTEGRATIONS
}

/**
 * Apply each given partner's IDML target normalization in turn. With no partner
 * folders the list is empty and this is the identity function, which is the
 * correct generic behaviour: nothing in a generic IDML package needs a
 * publisher's typesetting stripped out of the translation.
 */
export function normalizeIdmlTargetHtmlWith(
  integrations: readonly PartnerIntegration[],
  cellMetadata: Record<string, unknown> | null | undefined,
  sourceHtml: string,
  targetHtml: string,
  metadata: Parameters<IdmlTargetHtmlNormalizer>[3],
): string {
  return integrations.reduce(
    (html, integration) =>
      (integration.idmlTargetHtmlNormalizers ?? []).reduce(
        (acc, normalize) => normalize(cellMetadata, sourceHtml, acc, metadata),
        html,
      ),
    targetHtml,
  )
}

export function normalizePartnerIdmlTargetHtml(
  cellMetadata: Record<string, unknown> | null | undefined,
  sourceHtml: string,
  targetHtml: string,
  metadata: Parameters<IdmlTargetHtmlNormalizer>[3],
): string {
  return normalizeIdmlTargetHtmlWith(
    INTEGRATIONS,
    cellMetadata,
    sourceHtml,
    targetHtml,
    metadata,
  )
}

/**
 * Whether any given partner reads this cell as its Bible text (AQU-1285). With
 * no partner folders the list is empty and the answer is always false — a
 * generic file has no partner scripture to mark.
 */
export function isScriptureCellWith(
  integrations: readonly PartnerIntegration[],
  cellMetadata: unknown,
): boolean {
  return integrations.some((integration) => integration.isScriptureCell?.(cellMetadata) === true)
}

export function isPartnerScriptureCell(cellMetadata: unknown): boolean {
  return isScriptureCellWith(INTEGRATIONS, cellMetadata)
}

/**
 * Export-dialog options a partner registered for this file's profile. Empty
 * when the profile is missing or no partner claimed it — including the public
 * copy, where the partner folders are gone.
 */
/**
 * Which present partner imported a file with this profile. Null when the
 * profile is missing, generic, or the partner folder has been stripped — the
 * caller then stays on the general file upload.
 */
export function partnerIdForImportProfileWith(
  integrations: readonly PartnerIntegration[],
  profileId: string | null | undefined,
): string | null {
  const id = profileId?.trim()
  if (!id) return null
  return integrations.find((integration) => integration.importProfileIds?.includes(id))?.id ?? null
}

export function partnerIdForImportProfile(profileId: string | null | undefined): string | null {
  return partnerIdForImportProfileWith(INTEGRATIONS, profileId)
}

/**
 * Partner that should reopen for a sidebar re-import. The profile id wins.
 * The folder name is the fallback for a file loaded before the profile was
 * sent, and it misses a folder the user has renamed.
 */
export function partnerIdForImportedFileWith(
  integrations: readonly PartnerIntegration[],
  file: { importProfile?: string | null; corpusMarker?: string | null },
): string | null {
  if (file.importProfile?.trim()) {
    return partnerIdForImportProfileWith(integrations, file.importProfile)
  }
  const marker = file.corpusMarker?.trim()
  if (!marker) return null
  return integrations.find((integration) => integration.importCorpusMarkers?.includes(marker))?.id ?? null
}

export function partnerIdForImportedFile(
  file: { importProfile?: string | null; corpusMarker?: string | null },
): string | null {
  return partnerIdForImportedFileWith(INTEGRATIONS, file)
}

export function partnerIdmlExportOptionsFor(
  profileId: string | null | undefined,
): readonly PartnerIdmlExportOption[] {
  if (!profileId) return []
  return INTEGRATIONS.flatMap((integration) =>
    (integration.idmlExportOptions ?? []).filter((option) => option.profileIds.includes(profileId)),
  )
}
