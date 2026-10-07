import { GrantOriginBadge } from "@/components/access/GrantOriginBadge"
import { MemberInspectorTrigger } from "@/components/access/MemberInspectorTrigger"
import { roleLabel } from "@/components/access/labels"
import { formatScopePath, scopePathKey } from "@/lib/access/scope-path"
import type { ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import type { OrgAccessPerson } from "./org-access-data"

/** AQU-1352 §3.6: one row per person; chips read "Role @ breadcrumb" + origin. */
export function AccessPeopleView({ people, org }: { people: OrgAccessPerson[]; org: ScopeRef }) {
  const t = useT()
  return (
    <ul className="flex flex-col divide-y rounded-md border" data-testid="access-people">
      {people.map((p) => (
        <li key={p.userId} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start">
          <div className="flex w-48 shrink-0 items-baseline gap-2">
            <MemberInspectorTrigger userId={p.userId} username={p.displayName} from={{ type: "org", id: org.id }} herePath={[org]}>
              {p.displayName}
            </MemberInspectorTrigger>
            {p.isGuest && <span className="text-xs text-muted-foreground">{t("org.access.inspector.guest")}</span>}
          </div>
          <ul className="flex min-w-0 flex-wrap gap-1.5">
            {p.grants.map((g, i) => (
              <li
                key={`${scopePathKey(g.scopePath)}:${i}`}
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
                data-testid="access-chip"
              >
                <span>{t("org.access.page.chip", { role: roleLabel(t, g.roleLevel), path: formatScopePath(g.scopePath) })}</span>
                <GrantOriginBadge origin={g.origin} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}
