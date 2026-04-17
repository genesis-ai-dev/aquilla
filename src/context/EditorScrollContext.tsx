import { createContext, useContext, useState, useCallback, type ReactNode } from "react"

interface EditorScroll {
  pendingGroup: string | null
  requestScrollToGroup: (groupId: string) => void
  consume: () => string | null
}

const Ctx = createContext<EditorScroll | null>(null)

export function EditorScrollProvider({ children }: { children: ReactNode }) {
  const [pendingGroup, setPendingGroup] = useState<string | null>(null)
  const requestScrollToGroup = useCallback((g: string) => setPendingGroup(g), [])
  const consume = useCallback(() => {
    const g = pendingGroup
    if (g !== null) setPendingGroup(null)
    return g
  }, [pendingGroup])
  return <Ctx.Provider value={{ pendingGroup, requestScrollToGroup, consume }}>{children}</Ctx.Provider>
}

export function useEditorScroll(): EditorScroll {
  const v = useContext(Ctx)
  if (!v) throw new Error("useEditorScroll must be used inside EditorScrollProvider")
  return v
}
