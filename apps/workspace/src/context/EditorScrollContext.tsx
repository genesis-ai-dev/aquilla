import { createContext, useContext, useState, useCallback, type ReactNode } from "react"

interface EditorScroll {
  pendingGroup: string | null
  requestScrollToGroup: (groupId: string) => void
  /** Request scroll to a section label (e.g. "GEN 1"). Falls back to group match. */
  requestScrollToSection: (sectionLabel: string) => void
  pendingSection: string | null
  consume: () => { group: string | null; section: string | null }
}

const Ctx = createContext<EditorScroll | null>(null)

export function EditorScrollProvider({ children }: { children: ReactNode }) {
  const [pendingGroup, setPendingGroup] = useState<string | null>(null)
  const [pendingSection, setPendingSection] = useState<string | null>(null)
  const requestScrollToGroup = useCallback((g: string) => {
    setPendingGroup(g)
    setPendingSection(null)
  }, [])
  const requestScrollToSection = useCallback((s: string) => {
    setPendingSection(s)
    setPendingGroup(null)
  }, [])
  const consume = useCallback(() => {
    const g = pendingGroup
    const s = pendingSection
    if (g !== null) setPendingGroup(null)
    if (s !== null) setPendingSection(null)
    return { group: g, section: s }
  }, [pendingGroup, pendingSection])
  return (
    <Ctx.Provider value={{ pendingGroup, requestScrollToGroup, requestScrollToSection, pendingSection, consume }}>
      {children}
    </Ctx.Provider>
  )
}

export function useEditorScroll(): EditorScroll {
  const v = useContext(Ctx)
  if (!v) throw new Error("useEditorScroll must be used inside EditorScrollProvider")
  return v
}
