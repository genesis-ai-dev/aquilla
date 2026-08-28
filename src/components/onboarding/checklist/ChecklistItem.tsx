import { useEffect, useRef, useState } from "react"
import { CheckCircle2, ChevronDown, Circle } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

interface ChecklistItemProps {
  title: string
  /** Short, human-friendly explanation of WHY the user does this step. */
  description?: string
  complete: boolean
  /** When true, the item starts expanded on first mount. */
  defaultOpen?: boolean
  children: React.ReactNode
}

/**
 * A self-collapsing accordion row. The first time the `complete` prop
 * transitions false → true (e.g. user just hit Save inside the body) we
 * collapse automatically so the next unfinished step gets the focus.
 *
 * Left as a controlled-on-mount component on purpose: parents do not need
 * to hold open state per item, and we still respond to external completion
 * (e.g. another collaborator finishing the step).
 *
 * Visual language matches SettingsRow / SettingsGroup: a divide-y list row,
 * not a standalone tinted card. Completion is a status icon, not a wash.
 */
export function ChecklistItem({
  title,
  description,
  complete,
  defaultOpen,
  children,
}: ChecklistItemProps) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  const prevComplete = useRef(complete)

  useEffect(() => {
    if (!prevComplete.current && complete) {
      setOpen(false)
    }
    prevComplete.current = complete
  }, [complete])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="flex w-full items-start gap-3 px-4 py-3 text-start hover:bg-muted/40"
        >
          <CompletionIcon complete={complete} />
          <div className="min-w-0 flex-1 space-y-1">
            <div
              className={cn(
                "text-sm font-medium leading-snug",
                complete && "text-muted-foreground",
              )}
            >
              {title}
            </div>
            {description && (
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <ChevronDown
            className={cn(
              "mt-0.5 size-4 shrink-0 text-muted-foreground",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

function CompletionIcon({ complete }: { complete: boolean }) {
  if (complete) {
    return (
      <CheckCircle2
        className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400"
        aria-hidden
      />
    )
  }
  return (
    <Circle
      className="mt-0.5 size-4 shrink-0 text-muted-foreground/40"
      aria-hidden
    />
  )
}
