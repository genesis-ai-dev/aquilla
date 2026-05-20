// Minimal headless tabs primitive. Used by the cell expansion panel; we don't
// pull a full Radix-style tabs package because we only need a few behaviors:
// controlled value, click-to-switch, ARIA roles, keyboard arrow navigation.

import { createContext, useContext, useCallback, useId, useRef } from "react"
import { cn } from "@/lib/utils"

interface TabsCtx {
  value: string
  onValueChange: (next: string) => void
  baseId: string
}

const Ctx = createContext<TabsCtx | null>(null)

function useTabs() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("Tabs subcomponent must be inside <Tabs>")
  return ctx
}

export function Tabs({
  value, onValueChange, children, className,
}: {
  value: string
  onValueChange: (next: string) => void
  children: React.ReactNode
  className?: string
}) {
  const baseId = useId()
  return (
    <Ctx.Provider value={{ value, onValueChange, baseId }}>
      <div className={className} data-tabs-root>{children}</div>
    </Ctx.Provider>
  )
}

export function TabsList({
  children, className,
}: { children: React.ReactNode; className?: string }) {
  const listRef = useRef<HTMLDivElement | null>(null)

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return
    const triggers = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])') ?? [],
    )
    if (triggers.length === 0) return
    const active = document.activeElement as HTMLElement | null
    const idx = triggers.findIndex((t) => t === active)
    let next = idx
    if (e.key === "ArrowLeft") next = idx <= 0 ? triggers.length - 1 : idx - 1
    if (e.key === "ArrowRight") next = idx >= triggers.length - 1 ? 0 : idx + 1
    if (e.key === "Home") next = 0
    if (e.key === "End") next = triggers.length - 1
    e.preventDefault()
    triggers[next]?.focus()
    triggers[next]?.click()
  }, [])

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full bg-background p-0.5 shadow-neu-inset",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function TabsTrigger({
  value, children, disabled, className, attentionDot,
}: {
  value: string
  children: React.ReactNode
  disabled?: boolean
  className?: string
  /** Tiny dot in the corner indicating something inside this tab needs attention. */
  attentionDot?: "amber" | "emerald" | "red"
}) {
  const { value: current, onValueChange, baseId } = useTabs()
  const active = current === value
  const dotColor = attentionDot === "amber"
    ? "bg-amber-500"
    : attentionDot === "red"
      ? "bg-red-500"
      : attentionDot === "emerald"
        ? "bg-emerald-500"
        : null
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-trigger-${value}`}
      aria-selected={active}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={active ? 0 : -1}
      disabled={disabled}
      onClick={() => onValueChange(value)}
      className={cn(
        "relative inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium tracking-tight transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-background text-foreground shadow-neu-xs"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
      {dotColor && (
        <span
          aria-hidden
          className={cn(
            "absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-background",
            dotColor,
          )}
        />
      )}
    </button>
  )
}

export function TabsContent({
  value, children, className,
}: {
  value: string
  children: React.ReactNode
  className?: string
}) {
  const { value: current, baseId } = useTabs()
  if (current !== value) return null
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-trigger-${value}`}
      tabIndex={0}
      className={cn("focus:outline-none", className)}
    >
      {children}
    </div>
  )
}
