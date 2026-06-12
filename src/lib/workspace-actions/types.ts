import type { LucideIcon } from "lucide-react"
import type { NavigateFunction } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"

export interface FileProgressEntry {
  translated: number
  validated: number
  total: number
}

export interface WorkspaceActionContext {
  project: ProjectRecord
  activeFileId: string | null
  fileProgress: Map<string, FileProgressEntry>
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
  runAgentInput: () => void
  runImportWip: () => void
  /** File-scoped target import — populate the open file's translations. */
  runImportIntoFile: () => void
  runTranscribeAll: () => void
  runSynthAll: () => void
  navigate: NavigateFunction
}

export interface WorkspaceAction {
  id: string
  label: string
  icon?: LucideIcon
  group: "primary" | "secondary"
  isAvailable: (ctx: WorkspaceActionContext) => boolean
  isDefault?: (ctx: WorkspaceActionContext) => boolean
  requiresConfirmation?: {
    title: string
    description: (ctx: WorkspaceActionContext) => string
    confirmLabel: string
  }
  comingSoon?: boolean
  run: (ctx: WorkspaceActionContext, args: WorkspaceActionRunArgs) => void
}
