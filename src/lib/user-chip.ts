// Identity for the one user chip (AQU-1411).
//
// The label is the account username. The user id is never part of the label —
// it belongs in the tooltip. A missing username is the word "User" (supplied
// by the catalog at the call site) plus a shape and color hashed from the
// user id, so two people without usernames stay distinguishable and look the
// same everywhere.
//
// This does not invent a human name. AQU-1180 replaces translator identity
// with a per-project pseudonym on the agent API; this module must not turn
// that back into a real name, an email, or users.display_name. Callers pass
// the account username only.

import { isPlaceholderUsername } from "@/lib/sync/anonymous-name"

/** Geometric marks. No initials, so every anonymous chip is not the letters "US". */
export const USER_CHIP_SHAPES = ["circle", "square", "diamond", "triangle", "hexagon"] as const

export type UserChipShape = (typeof USER_CHIP_SHAPES)[number]

/** Twelve hues. Combined with the five shapes this is sixty stable identities. */
const HUE_COUNT = 12

export interface UserChipAppearance {
  shape: UserChipShape
  /** CSS color. Stable for a given id. */
  color: string
}

/** Account username, or null when the chip should say "User". */
export function usernameForChip(username: string | null | undefined): string | null {
  if (isPlaceholderUsername(username)) return null
  const trimmed = username!.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** FNV-1a, unsigned. The same id always lands on the same shape and hue. */
export function hashUserChipId(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Shape and color for a person with no username.
 * An empty id has one neutral mark — there is nothing to tell two of them apart.
 */
export function appearanceForUserId(id: string | number | null | undefined): UserChipAppearance {
  const key = id == null ? "" : String(id).trim()
  if (!key) return { shape: "circle", color: "hsl(220 8% 46%)" }
  const hash = hashUserChipId(key)
  const shape = USER_CHIP_SHAPES[hash % USER_CHIP_SHAPES.length]!
  const hue = (Math.floor(hash / USER_CHIP_SHAPES.length) % HUE_COUNT) * (360 / HUE_COUNT)
  return { shape, color: `hsl(${hue} 55% 42%)` }
}
