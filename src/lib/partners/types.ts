/**
 * The partner-integration contract (AQU-1286).
 *
 * Publisher-specific code — importers that read one publisher's InDesign
 * templates, their note rules, their fixtures — lives in a `partner-integrations`
 * folder and is reachable from the generic app ONLY through the descriptors in
 * this file. Nothing under `src/lib` or `src/components` may import a partner
 * module directly.
 *
 * The point is that the open-source copy of this repo is produced by *deleting*
 * those folders (see `scripts/make-public-copy.ts`), so every seam has to
 * survive their absence: the app must still compile, still build, and still run,
 * with the partner's import options simply not offered. See
 * `docs/PARTNER-INTEGRATIONS.md`.
 */

import type { ComponentType } from "react"
import type { LucideIcon } from "lucide-react"
import type { IdmlFormatMetadataV2, IdmlProgress } from "@aquilla/idml-roundtrip"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { FileReference, TranslatableString } from "@/lib/parsers/types"

/** Progress phases reported while a partner package is read and saved. */
export type PartnerImportPhase = "parse" | "save"

export interface PartnerImportProgress {
  phase: PartnerImportPhase
  /** Engine parse progress, while the package is being read. */
  idml?: IdmlProgress
  cellsEnqueued?: number
  cellsTotal?: number
  /** Paragraphs left out because they are scripture rather than notes. */
  verseUnitCount?: number
}

/**
 * What one partner reader returns, normalized. Each upstream extractor names
 * these differently because each counts a different thing as scripture; the
 * edition descriptor is where that difference is flattened, so the generic
 * importer never has to know which reader ran.
 */
export interface PartnerParseOutcome {
  strings: TranslatableString[]
  bookCodes: string[]
  /** Paragraphs left out because they are the published Bible text. */
  skippedScriptureCount: number
  /**
   * The package is a front/back matter volume — no scripture anywhere, so an
   * empty result is a legitimate artwork-only volume rather than a package read
   * with the wrong edition.
   */
  frontBackMatter: boolean
}

export interface PartnerParseOptions {
  signal?: AbortSignal
  onProgress: (progress: IdmlProgress) => void
  splitSentences?: boolean
}

/**
 * One title/template a partner ships. Nothing inside an IDML package identifies
 * which template it is and the templates disagree about what a paragraph style
 * means, so the person importing picks the edition and this descriptor says how
 * to read it, where its cells file, and what to say when it yields nothing.
 */
export interface PartnerImportEdition {
  /** Stable id, namespaced by partner — e.g. `biblica:study-notes`. */
  id: string
  /** `builtin:*` profile id stamped onto the file and its `parserVersion`. */
  profileId: string
  /** Sidebar folder, so a project holding several of a partner's titles keeps them apart. */
  corpusMarker: string
  /** Read the package. Lazily pulls in the partner's parser, so it stays code-split. */
  parse(buffer: ArrayBuffer, options: PartnerParseOptions): Promise<PartnerParseOutcome>
  /**
   * What to say when a package parsed but yielded nothing. The overwhelmingly
   * likely cause is the wrong edition, so the message names what it looked for.
   */
  emptyImportMessage(fileName: string): string
}

export interface PartnerImportPanelProps {
  projectId: string
  username: string
  sourceLanguage?: string
  targetLanguage?: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference) => void | Promise<void>
}

/**
 * The tile a partner contributes to the import dialog's landing screen, and the
 * panel behind it. The panel is a lazy import so the partner's UI — and the
 * parsers it reaches — stay out of the app's initial bundle.
 */
export interface PartnerImportScreen {
  titleKey: MessageKey
  hintKey?: MessageKey
  descriptionKey: MessageKey
  icon: LucideIcon
  badge?: "beta" | "soon"
  panel: () => Promise<{ default: ComponentType<PartnerImportPanelProps> }>
}

/**
 * A publisher-specific normalization applied to a translated IDML cell before it
 * is validated, for typesetting a publisher's templates carry that is not text
 * (see the apostrophe glue in AQU-1174). Returns the html unchanged when it does
 * not apply, and must be synchronous — it runs inside the completion path.
 */
export type IdmlTargetHtmlNormalizer = (
  cellMetadata: Record<string, unknown> | null | undefined,
  sourceHtml: string,
  targetHtml: string,
  metadata: IdmlFormatMetadataV2,
) => string

/**
 * One partner's whole contribution, the default export of its `register.ts`.
 *
 * Note what is NOT here: the partner's editions. Which templates a publisher
 * ships, and which one a given package is, is the partner's own business — its
 * panel picks an edition and hands the descriptor to `importPartnerNotes`. The
 * registry therefore carries only what generic code has to discover on its own:
 * the tile to offer, and the hooks that run inside generic paths.
 */
export interface PartnerIntegration {
  /** Folder name under `src/partner-integrations/`, e.g. `biblica`. */
  id: string
  importScreen?: PartnerImportScreen
  idmlTargetHtmlNormalizers?: readonly IdmlTargetHtmlNormalizer[]
}
