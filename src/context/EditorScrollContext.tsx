import { createContext, useContext, useState, useCallback, type ReactNode } from "react"

interface PendingScroll {
  /** The section label (e.g. "GEN 1") or null for group-based scroll. */
  section: string | null
  /** The group id or null for section-based scroll. */
  group: string | null
  /** FRO-250/254: the fileId this scroll was requested against. The handler
   *  must only consume() when cells belong to this same file — prevents the
   *  globalReferences-prefix fallback from matching the OLD file during a
   *  file-switch and burning the request before the new file's cells arrive. */
  fileId: string | null
}

interface EditorScroll {
  pending: PendingScroll | null
  requestScrollToGroup: (groupId: string, fileId: string) => void
  /** Request scroll to a section label (e.g. "GEN 1"). Falls back to group match. */
  requestScrollToSection: (sectionLabel: string, fileId: string) => void
  /** @deprecated Use pending instead. */
  pendingGroup: string | null
  /** @deprecated Use pending instead. */
  pendingSection: string | null
  consume: () => { group: string | null; section: string | null }
}

const Ctx = createContext<EditorScroll | null>(null)

export function EditorScrollProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingScroll | null>(null)
  const requestScrollToGroup = useCallback((g: string, fileId: string) => {
    setPending({ group: g, section: null, fileId })
  }, [])
  const requestScrollToSection = useCallback((s: string, fileId: string) => {
    setPending({ section: s, group: null, fileId })
  }, [])
  const consume = useCallback(() => {
    const p = pending
    if (p !== null) setPending(null)
    return { group: p?.group ?? null, section: p?.section ?? null }
  }, [pending])
  return (
    <Ctx.Provider value={{
      pending,
      requestScrollToGroup,
      requestScrollToSection,
      // backward-compat accessors
      pendingGroup: pending?.group ?? null,
      pendingSection: pending?.section ?? null,
      consume,
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function useEditorScroll(): EditorScroll {
  const v = useContext(Ctx)
  if (!v) throw new Error("useEditorScroll must be used inside EditorScrollProvider")
  return v
}
