import { useRef, useState, useEffect } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  workspaceActions, getDefaultAction, getVisibleActions,
} from "@/lib/workspace-actions/registry"
import type {
  WorkspaceActionContext, WorkspaceActionRunArgs, WorkspaceAction,
} from "@/lib/workspace-actions/types"
import { ConfirmActionDialog } from "./ConfirmActionDialog"

interface Props {
  ctx: WorkspaceActionContext
  run: WorkspaceActionRunArgs
}

export function PrimaryActionButton({ ctx, run }: Props) {
  const [open, setOpen] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<WorkspaceAction | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const defaultAction = getDefaultAction(workspaceActions, ctx)
  const visible = getVisibleActions(workspaceActions, ctx)
  const primary = visible.filter((a) => a.group === "primary")
  const secondary = visible.filter((a) => a.group === "secondary")

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  function handleRun(action: WorkspaceAction) {
    setOpen(false)
    if (action.requiresConfirmation) {
      setPendingConfirm(action)
    } else {
      action.run(ctx, run)
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <Button
        size="sm"
        className="rounded-r-none"
        onClick={() => handleRun(defaultAction)}
      >
        {defaultAction.icon && <defaultAction.icon className="h-4 w-4 mr-1.5" />}
        {defaultAction.label}
      </Button>
      <Button
        size="sm"
        className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-md border bg-popover p-1 shadow-md">
          {primary.map((a) => (
            <MenuItem
              key={a.id} action={a}
              isDefault={a.id === defaultAction.id}
              onClick={() => handleRun(a)}
            />
          ))}
          {secondary.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              {secondary.map((a) => (
                <MenuItem key={a.id} action={a} onClick={() => handleRun(a)} />
              ))}
            </>
          )}
        </div>
      )}
      {pendingConfirm?.requiresConfirmation && (
        <ConfirmActionDialog
          open={true}
          onOpenChange={(v) => { if (!v) setPendingConfirm(null) }}
          title={pendingConfirm.requiresConfirmation.title}
          description={pendingConfirm.requiresConfirmation.description(ctx)}
          confirmLabel={pendingConfirm.requiresConfirmation.confirmLabel}
          checkboxLabel="I understand this change will be attributed to my account."
          onConfirm={() => { pendingConfirm.run(ctx, run); setPendingConfirm(null) }}
        />
      )}
    </div>
  )
}

function MenuItem({
  action, isDefault, onClick,
}: {
  action: WorkspaceAction
  isDefault?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-left hover:bg-accent",
        isDefault && "font-medium",
      )}
      onClick={onClick}
    >
      {action.icon && <action.icon className="h-4 w-4" />}
      <span>{action.label}</span>
    </button>
  )
}
