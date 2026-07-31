import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"

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
    <div
      className={
        "rounded-lg border transition-colors " +
        (complete ? "border-emerald-200/70 bg-emerald-50/40 dark:border-emerald-900/40 dark:bg-emerald-950/20" : "bg-card")
      }
    >
      <button
        className="flex w-full items-start gap-3 rounded-lg p-3 text-left text-sm hover:bg-accent/40"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <CompletionDot complete={complete} />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-tight">{title}</div>
          {description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        <ChevronDown
          className={
            "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform " +
            (open ? "rotate-0" : "-rotate-90")
          }
        />
      </button>
      {open && (
        <div className="border-t px-3 pb-3 pt-3">
          {children}
        </div>
      )}
    </div>
  )
}

function CompletionDot({ complete }: { complete: boolean }) {
  return (
    <div
      className={
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-lg " +
        (complete
          ? "bg-emerald-500 text-white"
          : "border-2 border-muted-foreground/25 bg-background")
      }
      aria-hidden
    >
      {complete && <Check className="h-3 w-3" strokeWidth={3} />}
    </div>
  )
}
