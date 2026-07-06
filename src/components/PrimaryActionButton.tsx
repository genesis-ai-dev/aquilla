import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
    if (action.comingSoon) return
    setOpen(false)
    if (action.requiresConfirmation) {
      setPendingConfirm(action)
    } else {
      action.run(ctx, run)
    }
  }

  return (
    <>
      <ButtonGroup>
        <Button
          size="sm"
          variant="outline"
          onClick={() => handleRun(defaultAction)}
        >
          {defaultAction.icon && <defaultAction.icon data-icon="inline-start" className="text-primary" />}
          {defaultAction.label}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                className="px-1.5 [&[aria-expanded=true]_svg]:rotate-180"
                aria-label="More actions"
              >
                <ChevronDown className="transition-transform duration-200" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuGroup>
              {primary.map((a) => (
                <ActionMenuItem
                  key={a.id}
                  action={a}
                  isDefault={a.id === defaultAction.id}
                  onSelect={() => handleRun(a)}
                />
              ))}
            </DropdownMenuGroup>
            {secondary.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {secondary.map((a) => (
                    <ActionMenuItem
                      key={a.id}
                      action={a}
                      onSelect={() => handleRun(a)}
                    />
                  ))}
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
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
  const disabled = action.comingSoon
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-left hover:bg-accent",
        isDefault && "font-medium",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
    >
      {action.icon && <action.icon className="h-4 w-4" />}
      <span>{action.label}</span>
    </button>
  )
}
