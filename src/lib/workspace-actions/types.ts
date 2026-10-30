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
  /**
   * Media redesign slice 2: the open language delivers Audio and no text, so
   * the text-only actions — AI drafting, validating text, generating a voice
   * from text — leave the menu (P2.3). Absent: every action as before.
   */
  audioOnlyLane?: boolean
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
    /** AQU-1109: cells with a take and an assigned clone, including ones
     *  already converted, so the menu can overwrite them. */
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
  /**
   * AQU-1759: may this person split this file's lines at their quotation
   * marks — the same gate as the row menu's entry (adds rows under the
   * project's setting, edits source text, file with no clock). A thunk because
   * that answer is settled further down the workspace than this context.
   */
  canSplitAtQuotes?: () => boolean
  /** AQU-1759: how many lines would split, and how many lines they would
   *  become. A thunk for the reason `batchValidateSummary` is one: it walks the
   *  whole file, and only the confirmation needs it. */
  quoteSplitSummary?: () => { rows: number; lines: number }
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
  runTranscribeAll: () => void
  runSynthAll: () => void
  runChangeVoiceAll: () => void
  /** AQU-1759: split every line of the file that holds more than one speaker. */
  runSplitAtQuotes: () => void
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
  /**
   * AQU-983: open the file-context batch modal instead of the plain confirm
   * dialog. The modal is where the reader chooses empty cells versus a
   * refresh, and ready cells versus untouched AI drafts.
   */
  opensFileModal?: "validate" | "draft-next" | "draft-all"
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
    /**
     * False when the body already says this run can do nothing (the reader
     * may not validate, or nothing here is eligible). The dialog then offers
     * no acknowledgement and no confirm button, only Close: a confirm that
     * sends nothing and repeats the body in an error toast is a dead end.
     * Absent means the action can always be confirmed.
     */
    canConfirm?: (ctx: WorkspaceActionContext) => boolean
  }
  comingSoon?: boolean
  run: (ctx: WorkspaceActionContext, args: WorkspaceActionRunArgs) => void
}
