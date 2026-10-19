/**
 * Smart Extensions: tab-wide notification of server-applied writes from the
 * project WebSocket (other people's edits, and echoes of our own), so mounted
 * extensions can refresh live. The workspace's event.applied handler
 * publishes; extension hosts subscribe. Our own flush acks arrive separately
 * through `subscribeAppliedEvents` (outbox-flush.ts).
 */

export interface ProjectAppliedFrame {
  project: string
  file?: string
  cell?: string
}

type Listener = (frame: ProjectAppliedFrame) => void
const listeners = new Set<Listener>()

export function publishProjectApplied(frame: ProjectAppliedFrame): void {
  for (const l of listeners) {
    try {
      l(frame)
    } catch (err) {
      console.warn("[extensions] applied listener failed:", err)
    }
  }
}

export function subscribeProjectApplied(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
