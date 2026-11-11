import { ArrowUpRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { roleRung } from "@/lib/access/role-scale"
import { formatScopePath } from "@/lib/access/scope-path"
import type { GrantOrigin, ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

import { originLabel, roleLabel } from "./labels"

/**
 * The rung utilities, spelled out. Tailwind finds class names by scanning the
 * source, so a `role-rung-${step}` template literal would be tree-shaken out
 * of the stylesheet — these literals are what keep the ramp in the build.
 * `role-rung-N` paints fill + ink as a pair (they cannot be mismatched);
 * `role-rung-N-edge` paints the dashed outline of an inherited pill.
 */
const RUNG_FILL: Record<number, string> = {
  1: "role-rung-1",
  2: "role-rung-2",
  3: "role-rung-3",
  4: "role-rung-4",
  5: "role-rung-5",
  6: "role-rung-6",
  7: "role-rung-7",
}
const RUNG_EDGE: Record<number, string> = {
  1: "role-rung-1-edge",
  2: "role-rung-2-edge",
  3: "role-rung-3-edge",
  4: "role-rung-4-edge",
  5: "role-rung-5-edge",
  6: "role-rung-6-edge",
  7: "role-rung-7-edge",
}

/** The place an inherited grant actually lives at: the innermost crumb the
 *  viewer is allowed to see. */
function sourcePlace(origin: GrantOrigin): ScopeRef | undefined {
  if (origin.kind !== "inherited") return undefined
  const visible = origin.from?.filter((s) => !s.hidden) ?? []
  return visible[visible.length - 1]
}

/**
 * AQU-2317 (AQU-1352 design board 2, "the role ladder"): one role, one pill.
 *
 * The fill is the role's rung on the `--primary`-derived lightness scale
 * (`src/lib/access/role-scale.ts`), so the seven levels read as darkness.
 * Shape carries where the role comes from:
 *
 * - **direct** — a solid pill.
 * - **inherited** — a dashed outline pill reading "· via <place>", with an
 *   ArrowUpRight, linking to the grant it comes from when `hrefFor` resolves
 *   the source place. Its ink is `--foreground`, the theme's own guaranteed
 *   pair against the page; the rung shows in the dashed edge.
 * - **creator / platform** — a solid pill with the origin spelled out, since
 *   neither is a place anyone can navigate to.
 *
 * "No access" and any level outside the canonical ladder get no rung at all —
 * a quiet pill, never a guessed colour.
 */
export function RoleBadge({
  roleLevel,
  origin,
  hrefFor,
  className,
}: {
  roleLevel: number | null
  origin: GrantOrigin
  /** URL for the place an inherited grant is set at. */
  hrefFor?: (scope: ScopeRef) => string | undefined
  className?: string
}) {
  const t = useT()
  const role = roleLabel(t, roleLevel)
  const rung = roleRung(roleLevel)
  const inherited = origin.kind === "inherited"
  const place = sourcePlace(origin)
  const path = origin.kind === "inherited" && origin.from?.length ? formatScopePath(origin.from) : undefined
  const href = place ? hrefFor?.(place) : undefined

  const label = inherited
    ? path
      ? t("org.access.roleBadge.via", { role, path })
      : t("org.access.roleBadge.origin", { role, origin: originLabel(t, origin) })
    : origin.kind === "direct"
      ? role
      : t("org.access.roleBadge.origin", { role, origin: originLabel(t, origin) })

  const shape = inherited
    ? cn("border-dashed bg-transparent text-foreground", rung && RUNG_EDGE[rung.step])
    : cn(rung ? RUNG_FILL[rung.step] : "bg-foreground/10 text-muted-foreground")

  const content = (
    <>
      {label}
      {inherited && <ArrowUpRight aria-hidden />}
    </>
  )

  const common = {
    "data-origin": origin.kind,
    "data-role-rung": rung ? String(rung.step) : undefined,
    "data-testid": "role-badge",
    title: path ? t("org.access.origin.inheritedFrom", { path }) : undefined,
    className: cn("rounded-full border", shape, className),
  }

  return href ? (
    <Badge {...common} render={<a href={href} />}>
      {content}
    </Badge>
  ) : (
    <Badge {...common}>{content}</Badge>
  )
}
