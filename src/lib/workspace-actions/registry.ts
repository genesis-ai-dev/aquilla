import { Plus, Sparkles, Download, CheckSquare, Mic, Wand2 } from "lucide-react"
import type {
  WorkspaceAction, WorkspaceActionContext,
} from "./types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { canPerform } from "@/lib/sync/role-policy"
import { batchValidateConfirmDescription } from "@/lib/review/batch-validate-summary"

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
    // AQU-481: source import emits `file.create` + N `source.cell.create`, and
    // `file.create` sits at PROJECT_LEAD (500) server-side — so a viewer's
    // import is always refused. This action was the one primary entry left
    // ungated (`() => true`), which is why the full type-picker dialog opened
    // for a read-only role with every importer clickable. The header button is
    // rendered outside this registry, so it carries its own disabled+tooltip
    // affordance (WorkspaceHeaderActions) rather than vanishing; `isAvailable`
    // is what makes the click itself refuse. Fails OPEN on an unknown role, so
    // local/legacy projects with no syncRole are unaffected.
    //
    // AQU-1365: the same dialog now also brings in a translation of a file
    // already in the project, which only commits target cells
    // (`target.cell.commit`, CONTRIBUTOR 400). So the action opens from
    // Contributor up; the dialog greys out New source text below Project lead.
    isAvailable: (c) => roleAllows(c, "file.create") || roleAllows(c, "target.cell.commit"),
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
      // AQU-1507: this body used to be built from file progress —
      // `total - validated` — which counts untranslated cells, untouched AI
      // drafts, cells this reader had already signed off and cells outside
      // their assignment, none of which the run touches. It promised "83 cells
      // are currently unvalidated" on a file where the run validated zero.
      // The count now comes from the very summary the run consumes
      // (`ctx.batchValidateSummary`), so the two cannot drift: change the
      // eligibility predicate and this number follows.
      description: (c, t, joinList) => {
        if (!c.activeFileId) return ""
        const summary = c.batchValidateSummary?.()
        if (!summary) return t("editor.batchValidate.noTarget")
        // AQU-586: a project may cap how many eligible cells one batch-validate
        // processes. 0/undefined keeps the "all eligible" behavior. The cap is
        // already applied inside the summary; it is passed again so the note
        // explaining "run again to continue" survives a run it did not trim.
        return batchValidateConfirmDescription(
          summary, t, joinList, c.project.completionSettings?.validationBatchSize,
        )
      },
      // Same imperative as the selection toolbar's button — reuse it rather
      // than mint a duplicate string in this namespace. It names its half now
      // ("Validate text"), which is what this dialog is about. The bare
      // "Validate" key stays for the agent card, whose per-row button is not
      // text-specific and whose accessible name already carries the reference.
      confirmLabelKey: "editor.selection.validateText",
      // Same summary as the body: a run that would validate nothing (no
      // permission, nothing here, nothing eligible) cannot be confirmed. The
      // walk on 10-02 ticked the box, pressed "Validate text" and got only the
      // body's sentence back as an error toast.
      canConfirm: (c) => {
        if (!c.activeFileId) return false
        const summary = c.batchValidateSummary?.()
        return !!summary && summary.validatable.length > 0
      },
    },
    run: (_c, args) => args.runBatchValidate(),
  },
  {
    // AQU-490. BESIDE the text action, never merged into it: Sam's ruling is
    // that combining them would be "really dumb" — signing off a translation
    // says nothing about whether anyone has listened to its recording.
    id: "batch-validate-audio",
    labelKey: "nav.workspaceActions.batchValidateAudio.label",
    icon: Mic,
    group: "primary",
    // Only where there is audio to validate at all, so a text-only project
    // never grows a menu item it can do nothing with.
    isAvailable: (c) =>
      c.activeFileId != null
      && roleAllows(c, "cell.audio.validate")
      && (c.audioCounts?.validatableTakes ?? 0) > 0,
    requiresConfirmation: {
      titleKey: "nav.workspaceActions.batchValidateAudio.title",
      description: (c, t) => {
        if (!c.activeFileId) return ""
        const takes = c.audioCounts?.validatableTakes ?? 0
        return t("nav.workspaceActions.batchValidateAudio.description", { takes })
      },
      confirmLabelKey: "nav.workspaceActions.batchValidateAudio.label",
    },
    run: (_c, args) => args.runBatchValidateAudio(),
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
