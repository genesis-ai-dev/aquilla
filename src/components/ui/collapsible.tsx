// Minimal controlled collapsible — dependency-free (the project's Base UI
// primitive uses a `render` prop rather than `asChild`, so a small local
// implementation matches the shadcn-style API our callers already expect).

import { createContext, useContext, cloneElement, isValidElement } from "react"
import type { ReactElement, ReactNode, MouseEvent } from "react"

interface CollapsibleContextValue {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null)

function useCollapsible(): CollapsibleContextValue {
  const ctx = useContext(CollapsibleContext)
  if (!ctx) throw new Error("Collapsible parts must be used within <Collapsible>")
  return ctx
}

interface CollapsibleProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
  children: ReactNode
}

function Collapsible({ open, onOpenChange, className, children }: CollapsibleProps) {
  return (
    <CollapsibleContext.Provider value={{ open, onOpenChange }}>
      <div data-slot="collapsible" data-state={open ? "open" : "closed"} className={className}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  )
}

interface CollapsibleTriggerProps {
  /** When set, render the single child element and merge the toggle handler. */
  asChild?: boolean
  children: ReactNode
}

function CollapsibleTrigger({ asChild, children }: CollapsibleTriggerProps) {
  const { open, onOpenChange } = useCollapsible()
  const toggle = () => onOpenChange(!open)

  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ onClick?: (e: MouseEvent) => void }>
    return cloneElement(child, {
      onClick: (e: MouseEvent) => {
        child.props.onClick?.(e)
        toggle()
      },
    })
  }

  return (
    <button type="button" data-slot="collapsible-trigger" onClick={toggle}>
      {children}
    </button>
  )
}

function CollapsibleContent({ children }: { children: ReactNode }) {
  const { open } = useCollapsible()
  if (!open) return null
  return <div data-slot="collapsible-content">{children}</div>
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
