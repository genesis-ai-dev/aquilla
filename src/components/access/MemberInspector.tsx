import { Button } from "@/components/ui/button"
import { formatScopePath, scopePathKey } from "@/lib/access/scope-path"
import type { AccessChainEntry, MemberAccess, ScopePath, ScopeType } from "@/lib/access/types"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

import { UserChip } from "@/components/UserChip"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { originLabel, roleLabel } from "./labels"

const SCOPE_ORDER: readonly ScopeType[] = ["org", "team", "project", "lane"]

/** Group headings, one per scope type (spec §3.8 rule 1). Reused catalog keys. */
const GROUP_HEADING = {
  org: "org.orgHome.organizations",
  team: "billing.settings.teams",
  project: "nav.projects",
  lane: "org.membersPanel.lanesLegend",
} as const satisfies Record<ScopeType, MessageKey>

function innermostType(path: ScopePath): ScopeType | undefined {
  return path[path.length - 1]?.type
}

/**
 * AQU-1352 §3.8: popover body answering "what is this person everywhere, and
 * why?". Read-only by design (rule 3) — the only action is a link out.
 * Sections are always "Effective here" then "Everything else" (rule 1).
 */
export function MemberInspector({
  member,
  herePath,
  isSelf = false,
  onManageAccess,
}: {
  member: MemberAccess
  /** The scope the inspector was opened from. */
  herePath: ScopePath
  /** Viewer is looking at themselves → "Your access" (rule 4). */
  isSelf?: boolean
  onManageAccess?: () => void
}) {
  const { t, locale } = useI18n()
  const fmtDate = (iso: string) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale, { month: "short", day: "numeric" })
  }
  const meta = (e: AccessChainEntry) =>
    [originLabel(t, e.origin), e.grantedAt ? fmtDate(e.grantedAt) : null].filter(Boolean).join(", ")

  const org = herePath[0]?.type === "org" ? herePath[0] : undefined
  const groups = SCOPE_ORDER.map((type) => ({
    type,
    entries: member.elsewhere.filter((e) => (innermostType(e.scopePath) ?? "lane") === type),
  })).filter((g) => g.entries.length > 0)
  return (
    <div className="flex w-full min-w-0 flex-col gap-3 text-sm" data-testid="member-inspector">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="truncate font-medium">
          {isSelf ? (
            t("org.access.inspector.yourAccess")
          ) : (
            <UserChip userId={member.userId} username={member.displayName} size="sm" nameClassName="text-sm" />
          )}
        </h3>
        {member.isGuest && (
          <span className="shrink-0 text-xs text-muted-foreground" data-testid="inspector-guest">
            {org ? t("org.access.inspector.guestOf", { org: org.name }) : t("org.access.inspector.guest")}
          </span>
        )}
      </header>

      <section data-section="effective-here" className="flex flex-col gap-1">
        <h4 className="text-xs text-muted-foreground">
          {t("org.access.inspector.effectiveHere", { path: formatScopePath(herePath) })}
        </h4>
        <p className="font-medium">{roleLabel(t, member.effectiveHere.roleLevel)}</p>
        <ul className="flex flex-col gap-0.5">
          {member.effectiveHere.chain.map((e, i) => (
            <li key={`${scopePathKey(e.scopePath)}#${i}`} className="flex flex-wrap gap-x-2">
              <span>{roleLabel(t, e.roleLevel)}</span>
              <span className="text-muted-foreground">@ {formatScopePath(e.scopePath)}</span>
              <span className="inline-flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                (
                {meta(e)}
                {meta(e) && e.grantedBy ? ", " : ""}
                {e.grantedBy ? (
                  <RichMessage
                    k="org.access.inspector.grantedBy"
                    values={{
                      name: (
                        <UserChip
                          userId={e.grantedByUserId}
                          username={e.grantedBy}
                          size="xs"
                          nameClassName="text-xs font-normal"
                        />
                      ),
                    }}
                  />
                ) : null}
                )
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section data-section="everything-else" className="flex flex-col gap-1">
        <h4 className="text-xs text-muted-foreground">{t("org.access.inspector.everythingElse")}</h4>
        {groups.length === 0 ? (
          <p className="text-muted-foreground">{t("org.access.inspector.nothingElse")}</p>
        ) : (
          groups.map((g) => (
            <div key={g.type} data-group={g.type} className="flex flex-col gap-0.5">
              <h5 className="text-xs font-medium">{t(GROUP_HEADING[g.type])}</h5>
              <ul className="flex flex-col gap-0.5">
                {g.entries.map((e, i) => (
                  <li key={`${scopePathKey(e.scopePath)}#${i}`} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {formatScopePath(e.scopePath)}
                      {e.descendantCount != null && e.descendantCount > 0 && (
                        <span className="text-muted-foreground">
                          {" ▸ "}
                          {t("org.orgHome.organizationsPanel.projectCount", { count: e.descendantCount })}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0">{roleLabel(t, e.roleLevel)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {onManageAccess && (
        <div>
          <Button variant="outline" size="sm" onClick={onManageAccess}>
            {t("org.access.inspector.manageAccess")}
          </Button>
        </div>
      )}
      {/* SWARM-TODO(AQU-1352): "Copy access report" action and "See all access" side-sheet expansion. */}
    </div>
  )
}
