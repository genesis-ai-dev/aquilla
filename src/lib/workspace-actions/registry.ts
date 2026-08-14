import { Plus, Sparkles, Download, CheckSquare, Upload, Mic, Wand2 } from "lucide-react"
import type {
  WorkspaceAction, WorkspaceActionContext,
} from "./types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { canPerform } from "@/lib/sync/role-policy"

// AQU-365: viewers (and any role below the action's server floor) must not
// see these buttons at all — clicking them either persists a write server
// can't refuse in time to avoid a confusing UX, or (pre-fix) looked like a
// silent no-op. canPerform fails OPEN when the role is unknown (local/legacy
// projects with no syncRole), so this never blocks non-cloud projects.
function roleAllows(ctx: WorkspaceActionContext, kind: string): boolean {
  return canPerform(kind, ctx.project.syncRole?.level ?? null)
}

// A deliberate human-review package, not a project scheduler. Research found
// 5–10 consecutive items to be a practical unit for workload estimation and
// review; larger files are advanced by running the next package. This is the
// default when a project hasn't customized `completionSettings.completionBatchSize`.
export const MAX_BATCH_COMPLETIONS = 10

// AQU-586: the project can override the "Run AI completions" package size.
// Falls back to MAX_BATCH_COMPLETIONS when unset or non-positive. Clamped to a
// sane ceiling so a bad stored value can't request an unbounded package.
export function completionBatchSizeFor(project: ProjectRecord): number {
  const raw = project.completionSettings?.completionBatchSize
  if (typeof raw === "number" && raw > 0) return Math.min(50, Math.floor(raw))
  return MAX_BATCH_COMPLETIONS
}

export function getVisibleActions(
  actions: WorkspaceAction[], ctx: WorkspaceActionContext,
): WorkspaceAction[] {
  return actions.filter((a) => a.isAvailable(ctx))
}

export function getDefaultAction(
  actions: WorkspaceAction[], ctx: WorkspaceActionContext,
): WorkspaceAction {
  const visible = getVisibleActions(actions, ctx)
  const selectable = visible.filter((a) => !a.comingSoon)
  const match = selectable.find((a) => a.isDefault?.(ctx))
  return match ?? selectable[0] ?? visible[0] ?? actions[0]
}

export const workspaceActions: WorkspaceAction[] = [
  {
    id: "import-new", labelKey: "nav.workspaceActions.import", icon: Plus, group: "primary",
    isAvailable: () => true,
    isDefault: (c) => c.activeFileId == null,
    run: (_c, args) => args.openImport(),
  },
  {
    id: "run-completions", labelKey: "nav.workspaceActions.runCompletions.label", icon: Sparkles, group: "primary",
    isAvailable: (c) => c.activeFileId != null && roleAllows(c, "target.cell.commit"),
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.translated < p.total
    },
    requiresConfirmation: {
      titleKey: "nav.workspaceActions.runCompletions.title",
      description: (c, t) => {
        if (!c.activeFileId) return ""
        const p = c.fileProgress.get(c.activeFileId)
        const untranslated = p ? p.total - p.translated : 0
        const next = Math.min(completionBatchSizeFor(c.project), untranslated)
        const remaining = untranslated - next
        return (
          t("nav.workspaceActions.runCompletions.description", { next }) +
          (remaining > 0 ? t("nav.workspaceActions.moreAfterThis", { count: remaining }) : "") +
          t("nav.workspaceActions.runCompletions.descriptionTail")
        )
      },
      // Same visible text as the button label above — reuse the same key.
      confirmLabelKey: "nav.workspaceActions.runCompletions.label",
    },
    run: (_c, args) => args.runCompletions(),
  },
  {
    id: "complete-all", labelKey: "nav.workspaceActions.completeAll.label", icon: Sparkles, group: "primary",
    isAvailable: (c) => {
      if (!c.activeFileId) return false
      if (!roleAllows(c, "target.cell.commit")) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.translated < p.total
    },
    requiresConfirmation: {
      titleKey: "nav.workspaceActions.completeAll.title",
      description: (c, t) => {
        if (!c.activeFileId) return ""
        const p = c.fileProgress.get(c.activeFileId)
        const untranslated = p ? p.total - p.translated : 0
        return t("nav.workspaceActions.completeAll.description", {
          untranslated,
          batchSize: completionBatchSizeFor(c.project),
        })
      },
      confirmLabelKey: "nav.workspaceActions.completeAll.confirmLabel",
    },
    run: (_c, args) => args.runCompleteAll(),
  },
  {
    id: "batch-validate", labelKey: "nav.workspaceActions.batchValidate.label", icon: CheckSquare, group: "primary",
    isAvailable: (c) => c.activeFileId != null && roleAllows(c, "cell.validate"),
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.translated === p.total && p.validated < p.total
    },
    requiresConfirmation: {
      titleKey: "nav.workspaceActions.batchValidate.title",
      description: (c, t) => {
        if (!c.activeFileId) return ""
        const p = c.fileProgress.get(c.activeFileId)
        const unvalidated = p ? p.total - p.validated : 0
        // AQU-586: a project may cap how many eligible cells one batch-validate
        // processes. 0/undefined keeps the "all eligible" behavior.
        const cap = c.project.completionSettings?.validationBatchSize
        const capNote =
          typeof cap === "number" && cap > 0
            ? t("nav.workspaceActions.batchValidate.capNote", { cap })
            : ""
        return t("nav.workspaceActions.batchValidate.description", { unvalidated }) + capNote
      },
      // Same imperative as the selection-toolbar Validate button — reuse it
      // rather than mint a duplicate "Validate" string in this namespace.
      confirmLabelKey: "editor.selection.validate",
    },
    run: (_c, args) => args.runBatchValidate(),
  },
  {
    id: "export", labelKey: "nav.workspaceActions.export", icon: Download, group: "primary",
    // AQU-253 (revised): stay visible even when org policy forbids export —
    // the ExportDialog shows a permission gate explaining the block, which
    // beats a menu item that silently disappears.
    isAvailable: (c) => c.activeFileId != null,
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.validated === p.total
    },
    run: (_c, args) => args.runExport(),
  },
  {
    // AQU-503: the label must carry the word "target" so PMs looking for the
    // "Target Import" option can find it — this file-scoped importer populates
    // the open file's TARGET column, distinct from the primary "Import" (source).
    id: "import-into-file", labelKey: "nav.workspaceActions.importIntoFile", icon: Upload, group: "secondary",
    isAvailable: (c) => c.activeFileId != null,
    run: (_c, args) => args.runImportIntoFile(),
  },
  {
    id: "transcribe-all", labelKey: "nav.workspaceActions.transcribeAll.label", icon: Mic, group: "secondary",
    isAvailable: (c) => c.activeFileId != null && (c.audioCounts?.untranscribed ?? 0) > 0,
    requiresConfirmation: {
      titleKey: "nav.workspaceActions.transcribeAll.title",
      description: (c, t) => {
        const n = c.audioCounts?.untranscribed ?? 0
        return t("nav.workspaceActions.transcribeAll.description", { n })
      },
      confirmLabelKey: "nav.workspaceActions.transcribeAll.confirmLabel",
    },
    run: (_c, args) => args.runTranscribeAll(),
  },
  {
    id: "synth-all", labelKey: "nav.workspaceActions.synthAll.label", icon: Wand2, group: "secondary",
    isAvailable: (c) => c.activeFileId != null && (c.audioCounts?.unsynthesized ?? 0) > 0,
    requiresConfirmation: {
      titleKey: "nav.workspaceActions.synthAll.title",
      description: (c, t) => {
        const n = c.audioCounts?.unsynthesized ?? 0
        return t("nav.workspaceActions.synthAll.description", { n })
      },
      confirmLabelKey: "nav.workspaceActions.synthAll.confirmLabel",
    },
    run: (_c, args) => args.runSynthAll(),
  },
]
