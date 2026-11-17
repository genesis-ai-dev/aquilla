/**
 * AQU-2317 (AQU-1352 design board 2, "the role ladder"): the seven role levels
 * laid out on ONE lightness scale derived from the `--primary` token — darker
 * is more. This module is the scale's single definition; `src/index.css` holds
 * the matching `--role-rung-N` / `--role-ink-*` tokens and the `role-rung-N`
 * utilities, and `RoleBadge` is the only component that paints them.
 *
 * Two properties the scale must keep, both machine-checked in
 * `role-scale.test.ts`:
 *
 * 1. **Monotonic.** Rung 1 (viewer) is the lightest and rung 7 (owner) the
 *    darkest, so the ladder is readable as darkness alone.
 * 2. **AA in both themes.** Each rung's fill is paired with one of two inks,
 *    and the pair clears 4.5:1. The fill lightness is set *absolutely* (only
 *    the chroma and hue come from `--primary`), so a rung and its ink carry the
 *    same contrast in light and dark theme — the ramp never follows
 *    `--background`.
 *
 * Contrast is computed from lightness alone, which is exact for the achromatic
 * case and conservative for ours: in Oklab the lightness of a grey is the cube
 * root of its relative luminance (`Y = L³`), and adding chroma at a fixed L
 * only moves Y slightly. Every pair below clears the floor by ≥ 35%, well
 * outside that wobble.
 */
import { ALL_ROLE_LEVELS, type RoleLevel } from "@/lib/frontier/roles"

/** Oklab lightness of the two inks (`--role-ink-dark` / `--role-ink-light`). */
export const ROLE_INK_LIGHTNESS = { dark: 0.2, light: 0.99 } as const

export type RoleInk = keyof typeof ROLE_INK_LIGHTNESS

export interface RoleRung {
  level: RoleLevel
  /** 1 (lightest) … 7 (darkest). The CSS utility is `role-rung-<step>`. */
  step: number
  /** Oklab lightness of the fill — mirrors `--role-rung-<step>` in index.css. */
  fillLightness: number
  /** Which ink the fill is paired with. */
  ink: RoleInk
}

/**
 * Fill lightness per rung, lightest first — one entry per rung of
 * `ALL_ROLE_LEVELS`. The step from rung 5 to rung 6 is where the ink flips to
 * light, which is also where the ladder turns managerial (project lead →
 * maintainer); the gap is deliberate, and the mid lightnesses it skips are
 * exactly the band where neither ink reaches 4.5:1.
 */
const FILL_LIGHTNESS: readonly number[] = [0.96, 0.89, 0.82, 0.75, 0.68, 0.45, 0.32]
const INK: readonly RoleInk[] = ["dark", "dark", "dark", "dark", "dark", "light", "light"]

export const ROLE_RUNGS: readonly RoleRung[] = ALL_ROLE_LEVELS.map((level, i) => ({
  level,
  step: i + 1,
  fillLightness: FILL_LIGHTNESS[i],
  ink: INK[i],
}))

const BY_LEVEL = new Map<number, RoleRung>(ROLE_RUNGS.map((r) => [r.level as number, r]))

/**
 * The rung for a role level, or `undefined` for "no access" (`null`) and for a
 * level outside the canonical ladder. Callers render those without a rung —
 * never on a guessed one.
 */
export function roleRung(level: number | null | undefined): RoleRung | undefined {
  return level == null ? undefined : BY_LEVEL.get(level)
}

/** Relative luminance of an Oklab lightness: in Oklab, `L` is `Y ** (1/3)`. */
export function lightnessLuminance(lightness: number): number {
  return lightness ** 3
}

/** WCAG 2.1 contrast ratio between two Oklab lightnesses. */
export function lightnessContrast(a: number, b: number): number {
  const ya = lightnessLuminance(a)
  const yb = lightnessLuminance(b)
  const [hi, lo] = ya >= yb ? [ya, yb] : [yb, ya]
  return (hi + 0.05) / (lo + 0.05)
}

/** Contrast of a rung's ink against its own fill. */
export function rungContrast(rung: RoleRung): number {
  return lightnessContrast(rung.fillLightness, ROLE_INK_LIGHTNESS[rung.ink])
}
