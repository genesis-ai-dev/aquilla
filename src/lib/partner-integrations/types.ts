import type { ComponentType, LazyExoticComponent } from "react"
import type { LucideIcon } from "lucide-react"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { FileReference } from "@/lib/parsers/types"

/** Props every partner import panel receives from the import dialog. */
export interface PartnerImportPanelProps {
  projectId: string
  username: string
  sourceLanguage?: string
  targetLanguage?: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference) => void | Promise<void>
}

/**
 * A partner-specific import source, registered in `index.ts` and rendered by
 * `ImportDialog`. Keeping partner sources behind this registry lets the
 * open-source build exclude a partner module wholesale (empty registry) without
 * touching the dialog.
 */
export interface PartnerImportSource {
  /** Unique screen id for the dialog (also the landing-card id). */
  id: string
  titleKey: MessageKey
  hintKey?: MessageKey
  descriptionKey: MessageKey
  icon: LucideIcon
  badge?: "beta" | "soon"
  /** Lazy so the partner module isn't pulled into the dialog's eager graph. */
  Panel:
    | ComponentType<PartnerImportPanelProps>
    | LazyExoticComponent<ComponentType<PartnerImportPanelProps>>
}
