import type { Page, WebSocket } from "@playwright/test"

function isPresenceFrame(payload: string | Buffer): boolean {
  try {
    const parsed = JSON.parse(payload.toString()) as { t?: unknown }
    return parsed.t === "presence"
  } catch {
    return false
  }
}

/**
 * Resolve after the project socket receives its initial presence snapshot.
 * Register this before navigation; waiting for a frame is the authoritative
 * indication that broadcasts can reach the page.
 *
 * Readiness is a property of the page's link to the project, not of any one
 * socket: the reconciler reconnects after a drop, and a socket it closes
 * while still CONNECTING surfaces here as `socketerror` ("WebSocket is closed
 * before the connection is established") with the replacement opening a few
 * ms later. So every socket for the project is watched, the first presence
 * frame on any of them resolves, and a socket that fails first only sharpens
 * the message of the one deadline this wait has.
 */
export function waitForProjectSyncReady(
  page: Page,
  projectId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const marker = `/parties/project-sync/${encodeURIComponent(projectId)}`
  const ready = new Promise<void>((resolve, reject) => {
    const watched = new Set<WebSocket>()
    let lastSocketError: string | null = null
    const timer = setTimeout(() => {
      cleanup()
      const seen = watched.size === 0
        ? "no socket for this project was opened"
        : `${watched.size} socket(s) opened${lastSocketError ? `; last socket error: ${lastSocketError}` : ""}`
      reject(new Error(
        `ProjectSync socket for ${projectId} did not receive a presence frame within ${timeoutMs}ms (${seen})`,
      ))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      page.off("websocket", onSocket)
      for (const socket of watched) {
        socket.off("framereceived", onFrame)
        socket.off("socketerror", onSocketError)
      }
    }
    const onFrame = ({ payload }: { payload: string | Buffer }) => {
      if (!isPresenceFrame(payload)) return
      cleanup()
      resolve()
    }
    const onSocketError = (error: string) => {
      lastSocketError = error
    }
    const onSocket = (candidate: WebSocket) => {
      if (!candidate.url().includes(marker)) return
      watched.add(candidate)
      candidate.on("framereceived", onFrame)
      candidate.on("socketerror", onSocketError)
    }

    page.on("websocket", onSocket)
  })
  // Specs create this before navigating and await it afterwards. Mark the
  // rejection as observed in between so a failure reaches the spec at its
  // `await` as an ordinary assertion error — not as a process-level unhandled
  // rejection, which makes the runner interrupt the test mid-navigation and
  // misreport every step still in flight (AQU-642-style "never mounted").
  ready.catch(() => {})
  return ready
}
