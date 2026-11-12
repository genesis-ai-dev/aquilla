// No auth/store imports: session storage can stop collection before its first await.
const listeners = new Set<() => void>()
export function suspendAnalytics(): void { for (const listener of listeners) listener() }
export function onAnalyticsBoundary(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
