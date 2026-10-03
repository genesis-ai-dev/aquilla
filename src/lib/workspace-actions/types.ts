import type { LucideIcon } from "lucide-react"
import type { NavigateFunction } from "react-router-dom"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { BatchValidateSummary } from "@/lib/review/batch-validate-summary"

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
    /** AQU-1109: cells whose selected take can be re-voiced into their
     *  assigned cloned voice and isn't already. */
    voiceChangeable?: number
    /** AQU-490: takes this viewer could still validate, policy applied. */
    validatableTakes?: number
  }
  /**
   * AQU-1507: the eligibility split the batch-validate RUN will apply, so its
   * confirmation dialog can promise the number of cells it is actually going to
   * validate instead of the file's whole unvalidated count.
   *
   * A thunk rather than a value: it walks every cell of the open file, and the
   * one action that needs it is behind a dialog that is usually never opened.
   * Absent means "cannot be computed here" — the dialog then falls back to the
   * no-target wording rather than inventing a count.
   */
  batchValidateSummary?: () => BatchValidateSummary
}

export interface WorkspaceActionRunArgs {
  openImport: () => void
  runCompletions: () => void
  runCompleteAll: () => void
  runExport: () => void
  runBatchValidate: () => void
  /** AQU-490: bulk AUDIO validation. Separate from the text one on purpose —
   *  a reviewer signing off translations has not listened to the takes. */
  runBatchValidateAudio: () => void
  /** File-scoped target import — populate the open file's translations. */
  runImportIntoFile: () => void
  runTranscribeAll: () => void
  runSynthAll: () => void
  runChangeVoiceAll: () => void
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
     *
     * `joinList` is `useFormat().list` (AQU-1507): a body that enumerates
     * several clauses needs a locale-aware join, not `", "`. Descriptions that
     * render one sentence simply ignore it.
     */
    description: (
      ctx: WorkspaceActionContext,
      t: TFunction,
      joinList: (items: readonly string[]) => string,
    ) => string
    confirmLabelKey: MessageKey
  }
  comingSoon?: boolean
  run: (ctx: WorkspaceActionContext, args: WorkspaceActionRunArgs) => void
}
