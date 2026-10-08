/**
 * mini-chat-window.ts — where the floating AI mini-chat rests (AQU-1651).
 *
 * The mini-chat is deliberately NOT a modal: the whole point is that a quick
 * question costs the reader nothing, so the source, the target and the
 * neighbouring passages stay on screen behind it. That makes two things worth
 * remembering between visits — where the reader parked the window, and whether
 * they left it collapsed to its bar. Both are per user and per device, like
 * the other preferences under `src/lib/store/`, and neither belongs on the
 * server: it is about how this person likes to work, not about the project.
 *
 * Position is the window's TOP-LEFT in viewport pixels, and it is clamped on
 * every read and every move. A window parked at the right edge of a wide
 * monitor must not land off-screen — and so out of reach — when the same user
 * opens the project on a laptop, and a corrupt or hand-edited stored value
 * must not strand it either. The clamp keeps the whole window inside the
 * viewport when it fits, and pins it to the top-left margin when it does not,
 * so the drag handle and the close button are always reachable.
 *
 * Key schema: `aq.agent-mini-chat.v1:<projectId>:<author>`.
 */

export interface MiniChatPoint {
  /** Distance from the viewport's left edge, in CSS pixels. */
  x: number
  /** Distance from the viewport's top edge, in CSS pixels. */
  y: number
}

export interface MiniChatSize {
  width: number
  height: number
}

export type MiniChatViewport = MiniChatSize

export interface MiniChatPlacement extends MiniChatPoint {
  /** True when the window is collapsed to its bar. */
  minimized: boolean
}

/** The floating window. Small enough to leave the passage readable beside it. */
export const MINI_CHAT_WINDOW_SIZE: MiniChatSize = { width: 384, height: 480 }
/** The collapsed bar the window minimizes to. */
export const MINI_CHAT_BAR_SIZE: MiniChatSize = { width: 240, height: 40 }
/** Breathing room kept between the window and the viewport edge. */
export const MINI_CHAT_EDGE_MARGIN = 12

export function miniChatSize(minimized: boolean): MiniChatSize {
  return minimized ? MINI_CHAT_BAR_SIZE : MINI_CHAT_WINDOW_SIZE
}

/**
 * Pull a point inside the viewport for a window of `size`.
 *
 * When the window is wider or taller than the viewport the upper bound falls
 * below the margin; the margin wins, so the window's top-left — which carries
 * the drag handle and the close button — stays on screen.
 */
export function clampMiniChatPoint(
  point: MiniChatPoint,
  size: MiniChatSize,
  viewport: MiniChatViewport,
): MiniChatPoint {
  const maxX = Math.max(MINI_CHAT_EDGE_MARGIN, viewport.width - size.width - MINI_CHAT_EDGE_MARGIN)
  const maxY = Math.max(MINI_CHAT_EDGE_MARGIN, viewport.height - size.height - MINI_CHAT_EDGE_MARGIN)
  const x = Number.isFinite(point.x) ? point.x : MINI_CHAT_EDGE_MARGIN
  const y = Number.isFinite(point.y) ? point.y : MINI_CHAT_EDGE_MARGIN
  return {
    x: Math.min(Math.max(x, MINI_CHAT_EDGE_MARGIN), maxX),
    y: Math.min(Math.max(y, MINI_CHAT_EDGE_MARGIN), maxY),
  }
}

/** First-open resting place: lower-right, out of the editor's reading column. */
export function defaultMiniChatPoint(size: MiniChatSize, viewport: MiniChatViewport): MiniChatPoint {
  return clampMiniChatPoint(
    {
      x: viewport.width - size.width - MINI_CHAT_EDGE_MARGIN * 2,
      y: viewport.height - size.height - MINI_CHAT_EDGE_MARGIN * 2,
    },
    size,
    viewport,
  )
}

function storageKey(owner: string): string {
  return `aq.agent-mini-chat.v1:${owner}`
}

interface StoredPlacement {
  x?: unknown
  y?: unknown
  minimized?: unknown
}

function readStored(owner: string): StoredPlacement | null {
  if (typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(storageKey(owner))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as StoredPlacement) : null
  } catch {
    // Unparseable or storage denied — the default placement is still usable.
    return null
  }
}

/**
 * The placement to open at: the stored one clamped to this viewport, or the
 * default corner. A stored point that is not a pair of finite numbers is
 * discarded on its own, so a bad position does not also forget that the user
 * left the window minimized.
 */
export function readMiniChatPlacement(owner: string, viewport: MiniChatViewport): MiniChatPlacement {
  const stored = readStored(owner)
  const minimized = stored?.minimized === true
  const size = miniChatSize(minimized)
  const hasPoint =
    typeof stored?.x === "number" &&
    typeof stored?.y === "number" &&
    Number.isFinite(stored.x) &&
    Number.isFinite(stored.y)
  const point = hasPoint
    ? clampMiniChatPoint({ x: stored.x as number, y: stored.y as number }, size, viewport)
    : defaultMiniChatPoint(size, viewport)
  return { ...point, minimized }
}

export function writeMiniChatPlacement(owner: string, placement: MiniChatPlacement): void {
  if (typeof localStorage === "undefined") return
  if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y)) return
  try {
    localStorage.setItem(
      storageKey(owner),
      JSON.stringify({ x: placement.x, y: placement.y, minimized: placement.minimized }),
    )
  } catch {
    // Quota or a storage policy must never make the window unusable; the
    // in-session placement is already applied by the caller.
  }
}

/** Viewport size, guarded for the non-browser render used by tests and SSR. */
export function currentMiniChatViewport(): MiniChatViewport {
  if (typeof window === "undefined") return { width: MINI_CHAT_WINDOW_SIZE.width, height: MINI_CHAT_WINDOW_SIZE.height }
  return { width: window.innerWidth, height: window.innerHeight }
}
