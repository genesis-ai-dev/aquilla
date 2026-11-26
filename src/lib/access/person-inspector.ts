/**
 * AQU-2323: the words of the person inspector, decided without React. Every
 * role and path comes from the server (person-access-data.ts); these only
 * phrase it.
 */
import type { TFunction } from "@/lib/i18n/I18nProvider"

import { placeParam } from "./place-lens"
import type { GrantOrigin, ScopeRef, ScopeType } from "./types"

export type PlaceCounts = Record<ScopeType, number>

const COUNT_KEY = {
  org: "org.access.person.orgCount",
  team: "org.access.people.teamCount",
  project: "org.access.people.projectCount",
  lane: "org.access.people.laneCount",
} as const satisfies Record<ScopeType, string>

const ORDER: ScopeType[] = ["org", "team", "project", "lane"]

/** "1 team · 3 projects · 2 language lanes": each kind with any places, outermost first. */
export function placeCountText(t: TFunction, counts: PlaceCounts): string {
  return ORDER.filter((kind) => counts[kind] > 0)
    .map((kind) => t(COUNT_KEY[kind], { count: counts[kind] }))
    .join(" · ")
}

/**
 * The path to draw for a place. A path that ends at a team is that team: the
 * shared breadcrumb drops team crumbs under an org (scopeCrumbs), which would
 * leave a team grant reading as the organization.
 */
export function placePath(path: readonly ScopeRef[]): ScopeRef[] {
  const last = path[path.length - 1]
  return last?.type === "team" && !last.hidden ? [last] : [...path]
}

export function placeName(t: TFunction, ref: ScopeRef): string {
  return ref.hidden || !ref.name ? t("org.access.person.hiddenPlace") : ref.name
}

interface RoleAt {
  kind: "direct" | "inherited" | "creator"
  via: ScopeRef | null
  alsoVia: readonly ScopeRef[]
  redundantDirect: boolean
}

/** The RoleBadge origin for a place's role: solid where granted, dashed from `via` where inherited. */
export function roleOrigin(role: RoleAt): GrantOrigin {
  if (role.kind === "creator") return { kind: "creator" }
  if (role.kind === "inherited" && role.via) return { kind: "inherited", from: [role.via] }
  return { kind: "direct" }
}

/**
 * The reason under a place, in words: where the role comes from, then a
 * second line when another path gives the same rung — naming the grant here
 * as the redundant one when it adds nothing.
 */
export function reasonLines(t: TFunction, role: RoleAt, list: (names: string[]) => string): string[] {
  const first = role.kind === "creator"
    ? t("org.access.person.reasonCreator")
    : role.kind === "direct"
      ? t("org.access.person.reasonDirect")
      : role.via && !role.via.hidden
        ? t("org.access.person.reasonVia", { place: role.via.name })
        : t("org.access.person.reasonViaHidden")
  if (role.alsoVia.length === 0) return [first]
  const names = list(role.alsoVia.map((ref) => placeName(t, ref)))
  return [
    first,
    role.redundantDirect ? t("org.access.person.reasonRedundant", { list: names }) : t("org.access.person.reasonAlso", { list: names }),
  ]
}

/** Where a "via" link goes: the Places lens, opened at that place. Null for a place the viewer cannot see. */
export function placeLensHref(accessPath: string, ref: ScopeRef): string | undefined {
  if (ref.hidden || !ref.id) return undefined
  return `${accessPath}?place=${encodeURIComponent(placeParam(ref))}`
}
