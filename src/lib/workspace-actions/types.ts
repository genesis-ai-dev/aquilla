import type { LucideIcon } from "lucide-react"
import type { NavigateFunction } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TFunction } from "@/lib/i18n/I18nProvider"

export interface FileProgressEntry {
  translated: number
  validated: number
  total: number
}

export interface WorkspaceActionContext {
  project: ProjectRecord
  activeFileId: string | null
  fileProgress: Map<string, FileProgressEntry>
  /** Org export-policy floor (AQU-253). When false, Export is hidden from the
   *  action menu — openExportFlow no-ops anyway, but don't show a dead item. */
  canExportByOrgPolicy?: boolean
  /** Counts driving the bulk audio actions in the secondary action group. */
  audioCounts?: {
    /** Cells with a recording but no Whisper timings yet. */
    untranscribed: number
    /** Cells with translated text but no recording yet. */
    unsynthesized: number
  }
}

export interface WorkspaceActionRunArgs {
  openImport: () => void
  runCompletions: () => void
  runCompleteAll: () => void
  runExport: () => void
  runBatchValidate: () => void
  /** File-scoped target import — populate the open file's translations. */
  runImportIntoFile: () => void
  runTranscribeAll: () => void
  runSynthAll: () => void
  navigate: NavigateFunction
}

export interface WorkspaceAction {
  id: string
  /** i18n catalog key for the visible label — a `MessageKey`-typed field makes
   *  an unkeyed action a compile error (same pattern as LeftDock's `TabMeta`). */
  labelKey: MessageKey
  icon?: LucideIcon
  group: "primary" | "secondary"
  isAvailable: (ctx: WorkspaceActionContext) => boolean
  isDefault?: (ctx: WorkspaceActionContext) => boolean
  requiresConfirmation?: {
    titleKey: MessageKey
    /**
     * The confirmation body has per-run counts baked in (how many cells, what
     * batch size), so it can't be a static key — it's resolved at render by
     * calling the injected `t` here, same as everywhere else in the app,
     * rather than returning pre-resolved English from the registry.
     */
    description: (ctx: WorkspaceActionContext, t: TFunction) => string
    confirmLabelKey: MessageKey
  }
  comingSoon?: boolean
  run: (ctx: WorkspaceActionContext, args: WorkspaceActionRunArgs) => void
}
