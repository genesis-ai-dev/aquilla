import { createContext, useContext, useMemo, useState, type ReactNode } from "react"

interface SyncingState {
  syncing: boolean
  setSyncing: (v: boolean) => void
}

const Ctx = createContext<SyncingState>({ syncing: false, setSyncing: () => {} })

export function SyncingProvider({ children }: { children: ReactNode }) {
  const [syncing, setSyncing] = useState(false)
  const value = useMemo(() => ({ syncing, setSyncing }), [syncing])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSyncing(): SyncingState {
  return useContext(Ctx)
}
