// Click-to-expand error popover used by per-cell AI status badges
// (transcription, TTS). The trigger is whatever the parent passes — usually
// the small red "Failed" pill — and the popover surfaces the full error
// message plus a small set of context-aware actions (set API key, retry,
// dismiss). Replaces the prior tooltip-only treatment that hid errors in
// `title=` attributes.

import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { AlertCircle, X } from "lucide-react"
import type { ActionableError } from "@/lib/audio/ai-error"

export interface AiStatusAction {
  label: string
  onClick: () => void
  /** Renders as a filled primary button. Only one action should be primary. */
  primary?: boolean
}

interface Props {
  trigger: ReactElement
  error: ActionableError
  actions: AiStatusAction[]
  /** Always rendered as a "Dismiss" button next to the actions. */
  onDismiss: () => void
}

export function CellAiStatusPopover({ trigger, error, actions, onDismiss }: Props) {
  return (
    <Popover>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-72 space-y-3 p-3 text-xs"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <div className="text-sm font-medium leading-tight">{error.title}</div>
            <p className="text-muted-foreground leading-snug">{error.body}</p>
            {error.body !== error.raw && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] text-muted-foreground/70 hover:text-muted-foreground">
                  Technical detail
                </summary>
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-1.5 text-[10px] text-muted-foreground">
                  {error.raw}
                </pre>
              </details>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onDismiss}
            className="h-7 gap-1 px-2 text-[11px]"
          >
            <X className="h-3 w-3" />
            Dismiss
          </Button>
          {actions.map((action, i) => (
            <Button
              key={`${action.label}-${i}`}
              type="button"
              size="sm"
              variant={action.primary ? "default" : "outline"}
              onClick={action.onClick}
              className={cn("h-7 px-2 text-[11px]")}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
