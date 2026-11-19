import type { ScopePath, ScopeRef, ScopeType } from "./types"

/**
 * AQU-2361: one helper writes a scope. The tree is Organization › Project ›
 * Lane (AQU-2351 D-b, D-c). A team is a group, not a crumb — callers show it
 * as a "via team …" chip beside this string. Page titles, add-people
 * headers, grant chips and denials all call this, so they cannot disagree.
 */

/** U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION MARK, space-padded. */
export const SCOPE_SEPARATOR = " › "
/** U+2026 HORIZONTAL ELLIPSIS — placeholder for ancestors the viewer cannot see. */
export const HIDDEN_ANCESTORS = "…"

const TREE_LEVELS = new Set<ScopeType>(["org", "project", "lane"])

/**
 * Crumbs of the tree, outermost first.
 *
 * Teams drop out of a path that also has an org, project or lane. A path that
 * is only a team (a group page, or one node in the access tree) keeps that
 * name so the label does not go blank.
 *
 * At most one lane: a second lane on the path is a sibling the viewer must
 * not be told about (AQU-1421). Hidden lanes are dropped entirely — they are
 * not ancestors, so they do not become an ellipsis.
 */
export function scopeCrumbs(path: ScopePath): ScopePath {
  const tree = path.filter((s) => TREE_LEVELS.has(s.type))
  const base = tree.length > 0 ? tree : path.filter((s) => s.type === "team")
  const lanes = base.filter((s) => s.type === "lane" && !s.hidden)
  const lane = lanes.length > 0 ? lanes[lanes.length - 1] : undefined
  return base.filter((s) => s.type !== "lane" || s === lane)
}

/**
 * Spec §3.9 rule 4: ancestors marked `hidden` collapse into one leading "…"
 * for every caller. Visibility travels on the crumbs, so no caller can forget
 * to truncate or invent a name the server withheld.
 */
export function formatScopePath(path: ScopePath): string {
  const crumbs = scopeCrumbs(path)
  const names = crumbs.filter((s) => !s.hidden).map((s) => s.name)
  if (names.length < crumbs.length) names.unshift(HIDDEN_ANCESTORS)
  return names.join(SCOPE_SEPARATOR)
}

/**
 * Display name of a team on this path the viewer is allowed to see.
 * A hidden team contributes nothing — the name never leaks into a chip.
 */
export function viaTeamName(path: ScopePath): string | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const scope = path[i]
    if (scope.type !== "team" || scope.hidden) continue
    const name = scope.name.trim()
    if (name) return name
  }
  return null
}

/**
 * Where an inherited grant is edited. A team is the group's own name, not a
 * tree crumb. Anything else is the scope string.
 */
export function formatGrantPlace(path: ScopePath): string {
  const visible = path.filter((s) => !s.hidden)
  const last = visible[visible.length - 1]
  if (last?.type === "team" && last.name.trim()) return last.name
  return formatScopePath(path)
}

function isScopeType(value: unknown): value is ScopeType {
  return value === "org" || value === "team" || value === "project" || value === "lane"
}

/**
 * A denial's `scopePath` may be the legacy string list or structured crumbs
 * with `hidden`. Hidden ancestors and sibling lanes follow the same rules as
 * `formatScopePath` — a walled member is not told a name they cannot see.
 */
export function formatDenialScope(raw: unknown): string {
  if (!Array.isArray(raw)) return ""
  const path: ScopeRef[] = []
  for (const item of raw) {
    if (typeof item === "string") {
      const hidden = item === "" || item === HIDDEN_ANCESTORS
      path.push({
        type: "project",
        id: item,
        name: hidden ? "" : item,
        ...(hidden ? { hidden: true as const } : {}),
      })
      continue
    }
    if (!item || typeof item !== "object") continue
    const rec = item as { type?: unknown; id?: unknown; name?: unknown; hidden?: unknown }
    const name = typeof rec.name === "string" ? rec.name : ""
    const hidden = rec.hidden === true || name === "" || name === HIDDEN_ANCESTORS
    path.push({
      type: isScopeType(rec.type) ? rec.type : "project",
      id: typeof rec.id === "string" ? rec.id : name,
      name: hidden ? "" : name,
      ...(hidden ? { hidden: true as const } : {}),
    })
  }
  return formatScopePath(path)
}

/** Stable identity for a path (ids, not names) — for React keys and dedup. */
export function scopePathKey(path: ScopePath): string {
  return path.map((s) => `${s.type}:${s.id}`).join("/")
}
