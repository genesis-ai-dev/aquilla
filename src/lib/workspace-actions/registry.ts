import { Plus, Sparkles, Download, CheckSquare, Bot, Upload } from "lucide-react"
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
    id: "import-new", label: "+ Import", icon: Plus, group: "primary",
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
]
