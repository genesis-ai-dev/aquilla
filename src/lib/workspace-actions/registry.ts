import { Plus, Sparkles, Download, CheckSquare, Bot, Upload, Mic, Wand2 } from "lucide-react"
import type {
  WorkspaceAction, WorkspaceActionContext,
} from "./types"
import { canPerform } from "@/lib/sync/role-policy"

// AQU-365: viewers (and any role below the action's server floor) must not
// see these buttons at all — clicking them either persists a write server
// can't refuse in time to avoid a confusing UX, or (pre-fix) looked like a
// silent no-op. canPerform fails OPEN when the role is unknown (local/legacy
// projects with no syncRole), so this never blocks non-cloud projects.
function roleAllows(ctx: WorkspaceActionContext, kind: string): boolean {
  return canPerform(kind, ctx.project.syncRole?.level ?? null)
}

// Cap on cells generated per "Run AI completions" click. Set to 50 so a
// single scripture chapter (typically 25-50 verses) completes in one pass —
// consultants re-run for the next chapter. Large enough to be useful for
// Matthew; small enough that a misclick on a 1000-verse Psalms isn't
// catastrophic. Revisit when spend controls are in place.
export const MAX_BATCH_COMPLETIONS = 50

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
    id: "import-new", label: "Import", icon: Plus, group: "primary",
    isAvailable: () => true,
    isDefault: (c) => c.activeFileId == null,
    run: (_c, args) => args.openImport(),
  },
  {
    id: "run-completions", label: "Run AI completions", icon: Sparkles, group: "primary",
    isAvailable: (c) => c.activeFileId != null && roleAllows(c, "target.cell.commit"),
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.translated < p.total
    },
    requiresConfirmation: {
      title: "Run completions",
      description: (c) => {
        if (!c.activeFileId) return ""
        const p = c.fileProgress.get(c.activeFileId)
        const untranslated = p ? p.total - p.translated : 0
        const next = Math.min(MAX_BATCH_COMPLETIONS, untranslated)
        return `Generate translations for the next ${next} untranslated cell${next === 1 ? "" : "s"}${untranslated > next ? ` (${untranslated - next} more after this)` : ""}. Uses few-shot examples from validated cells — re-run to continue through the file.`
      },
      confirmLabel: "Run AI completions",
    },
    run: (_c, args) => args.runCompletions(),
  },
  {
    id: "complete-all", label: "Complete all", icon: Sparkles, group: "primary",
    isAvailable: (c) => {
      if (!c.activeFileId) return false
      if (!roleAllows(c, "target.cell.commit")) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.translated < p.total
    },
    requiresConfirmation: {
      title: "Complete all untranslated cells",
      description: (c) => {
        if (!c.activeFileId) return ""
        const p = c.fileProgress.get(c.activeFileId)
        const untranslated = p ? p.total - p.translated : 0
        // SWARM-TODO(complete-all-spend-dollars): replace ~N AI calls with a
        //   precise dollar estimate once per-model pricing constants are
        //   available here (needs model name + token-count estimate per cell).
        return `Draft AI translations for all ${untranslated} untranslated cell${untranslated === 1 ? "" : "s"} in this file (~${untranslated} AI call${untranslated === 1 ? "" : "s"}). This may take a while for large files.`
      },
      confirmLabel: "Complete all",
    },
    run: (_c, args) => args.runCompleteAll(),
  },
  {
    id: "batch-validate", label: "Batch validate…", icon: CheckSquare, group: "primary",
    isAvailable: (c) => c.activeFileId != null && roleAllows(c, "cell.validate"),
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.translated === p.total && p.validated < p.total
    },
    requiresConfirmation: {
      title: "Batch validate",
      description: (c) => {
        if (!c.activeFileId) return ""
        const p = c.fileProgress.get(c.activeFileId)
        const unvalidated = p ? p.total - p.validated : 0
        return `This marks ${unvalidated} translated cell${unvalidated === 1 ? "" : "s"} as validated under your name.`
      },
      confirmLabel: "Validate all",
    },
    run: (_c, args) => args.runBatchValidate(),
  },
  {
    id: "export", label: "Export", icon: Download, group: "primary",
    isAvailable: (c) => c.activeFileId != null && c.canExportByOrgPolicy !== false,
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.validated === p.total
    },
    run: (_c, args) => args.runExport(),
  },
  {
    id: "agent-input", label: "Agent input", icon: Bot, group: "primary",
    isAvailable: () => true,
    run: (_c, args) => args.runAgentInput(),
  },
  {
    id: "import-into-file", label: "Import translations into this file", icon: Upload, group: "secondary",
    isAvailable: (c) => c.activeFileId != null,
    run: (_c, args) => args.runImportIntoFile(),
  },
  {
    id: "transcribe-all", label: "Transcribe all audio", icon: Mic, group: "secondary",
    isAvailable: (c) => c.activeFileId != null && (c.audioCounts?.untranscribed ?? 0) > 0,
    requiresConfirmation: {
      title: "Transcribe all audio in this file",
      description: (c) => {
        const n = c.audioCounts?.untranscribed ?? 0
        return `Run Whisper on ${n} cell${n === 1 ? "" : "s"} that already have a recording but no karaoke timings yet.`
      },
      confirmLabel: "Transcribe all",
    },
    run: (_c, args) => args.runTranscribeAll(),
  },
  {
    id: "synth-all", label: "Generate AI voice for empty cells", icon: Wand2, group: "secondary",
    isAvailable: (c) => c.activeFileId != null && (c.audioCounts?.unsynthesized ?? 0) > 0,
    requiresConfirmation: {
      title: "Generate AI voice",
      description: (c) => {
        const n = c.audioCounts?.unsynthesized ?? 0
        return `Generate AI voice audio for ${n} cell${n === 1 ? "" : "s"} that have translated text but no recording yet. Existing recordings are not touched.`
      },
      confirmLabel: "Generate audio",
    },
    run: (_c, args) => args.runSynthAll(),
  },
]
