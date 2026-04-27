import { Plus, Sparkles, Download, CheckSquare, Bot, Upload, Mic, Wand2 } from "lucide-react"
import type {
  WorkspaceAction, WorkspaceActionContext,
} from "./types"

export function getVisibleActions(
  actions: WorkspaceAction[], ctx: WorkspaceActionContext,
): WorkspaceAction[] {
  return actions.filter((a) => a.isAvailable(ctx))
}

export function getDefaultAction(
  actions: WorkspaceAction[], ctx: WorkspaceActionContext,
): WorkspaceAction {
  const visible = getVisibleActions(actions, ctx)
  const match = visible.find((a) => a.isDefault?.(ctx))
  return match ?? visible[0] ?? actions[0]
}

export const workspaceActions: WorkspaceAction[] = [
  {
    id: "import-new", label: "Import", icon: Plus, group: "primary",
    isAvailable: () => true,
    isDefault: (c) => c.activeFileId == null,
    run: (_c, args) => args.openImport(),
  },
  {
    id: "run-completions", label: "Run completions", icon: Sparkles, group: "primary",
    isAvailable: (c) => c.activeFileId != null,
    isDefault: (c) => {
      if (!c.activeFileId) return false
      const p = c.fileProgress.get(c.activeFileId)
      return !!p && p.total > 0 && p.translated < p.total
    },
    run: (_c, args) => args.runCompletions(),
  },
  {
    id: "batch-validate", label: "Batch validate…", icon: CheckSquare, group: "primary",
    isAvailable: (c) => c.activeFileId != null,
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
    isAvailable: (c) => c.activeFileId != null,
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
    id: "import-wip", label: "Import work in progress", icon: Upload, group: "secondary",
    isAvailable: () => true,
    run: (_c, args) => args.runImportWip(),
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
        return `Synthesize Kokoro audio for ${n} cell${n === 1 ? "" : "s"} that have translated text but no recording yet. Existing recordings are not touched.`
      },
      confirmLabel: "Generate audio",
    },
    run: (_c, args) => args.runSynthAll(),
  },
]
