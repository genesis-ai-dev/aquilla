// AQU-1030: one sentence for every add/invite form, built from the form's
// current choices so the granter can see org vs project vs lane before they
// submit. The same sentence is the success toast; the button repeats the
// short scope echo ("every project", "French lane only").

import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TVars } from "@/lib/i18n/translate"
import { roleDisplayLabel, roleNameKey } from "@/lib/frontier/roles"

export type GrantTranslator = (key: MessageKey, vars?: TVars) => string

/**
 * What the grant covers.
 * - organization: the whole org, every project.
 * - project + lanes "all": the named project, every lane (no lane scope).
 * - project + lanes "unknown": the named project, lane list not loaded yet.
 * - project + lane labels: those lanes only.
 */
export type GrantScope =
  | { kind: "organization" }
  | {
      kind: "project"
      projectName: string
      lanes: "all" | "unknown" | readonly string[]
    }

export interface GrantScopeCopy {
  /** Full sentence, e.g. "Maria will join as a Contributor on Mark, French lane only". */
  sentence: string
  /** Short scope phrase for the submit button, e.g. "French lane only". */
  scopeEcho: string
}

export interface DescribeGrantInput {
  /** Usernames or an email. Ignored when `link` is set. Empty → "They will join…". */
  names?: readonly string[]
  /** Open invite link: the recipient is whoever redeems it. */
  link?: boolean
  roleLevel: number
  scope: GrantScope
  /** Locale for "A and B" lists. Defaults to English. */
  locale?: string
}

function formatList(items: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: "conjunction", style: "long" }).format([...items])
}

function roleLabel(t: GrantTranslator, level: number, count: number): string {
  const key = roleNameKey(level)
  return key ? t(key, { count }) : roleDisplayLabel(level)
}

function scopeParts(
  t: GrantTranslator,
  scope: GrantScope,
  locale: string,
): { scope: string; echo: string } {
  if (scope.kind === "organization") {
    return {
      scope: t("org.grantScope.scope.organization"),
      echo: t("org.grantScope.echo.organization"),
    }
  }
  const project = scope.projectName
  if (scope.lanes === "unknown") {
    const phrase = t("org.grantScope.scope.project", { project })
    return { scope: phrase, echo: phrase }
  }
  if (scope.lanes === "all") {
    return {
      scope: t("org.grantScope.scope.projectAllLanes", { project }),
      echo: t("org.grantScope.echo.allLanes"),
    }
  }
  const labels = scope.lanes.map((lane) => lane.trim()).filter(Boolean)
  if (labels.length === 0) {
    return {
      scope: t("org.grantScope.scope.projectAllLanes", { project }),
      echo: t("org.grantScope.echo.allLanes"),
    }
  }
  if (labels.length === 1) {
    return {
      scope: t("org.grantScope.scope.laneOnly", { project, lane: labels[0] }),
      echo: t("org.grantScope.echo.laneOnly", { lane: labels[0] }),
    }
  }
  const lanes = formatList(labels, locale)
  return {
    scope: t("org.grantScope.scope.lanesOnly", { project, lanes }),
    echo: t("org.grantScope.echo.lanesOnly", { lanes }),
  }
}

/** Sentence + button echo for the form's current subject, role, and scope. */
export function describeGrant(t: GrantTranslator, input: DescribeGrantInput): GrantScopeCopy {
  const locale = input.locale ?? "en"
  const names = (input.names ?? []).map((name) => name.trim()).filter(Boolean)
  const several = !input.link && names.length > 1
  const role = roleLabel(t, input.roleLevel, several ? names.length : 1)
  const parts = scopeParts(t, input.scope, locale)
  let sentence: string
  if (input.link) {
    sentence = t("org.grantScope.sentence.link", { role, scope: parts.scope })
  } else if (names.length === 0) {
    sentence = t("org.grantScope.sentence.unset", { role, scope: parts.scope })
  } else if (names.length === 1) {
    sentence = t("org.grantScope.sentence.person", { name: names[0], role, scope: parts.scope })
  } else {
    sentence = t("org.grantScope.sentence.people", {
      names: formatList(names, locale),
      role,
      scope: parts.scope,
    })
  }
  return { sentence, scopeEcho: parts.echo }
}

/** "{action} — {scope}", the submit label that repeats the scope echo. */
export function grantButtonLabel(t: GrantTranslator, action: string, scopeEcho: string): string {
  return t("org.grantScope.button", { action, scope: scopeEcho })
}

/** Project display name, or "this project" while the name is still loading. */
export function grantProjectName(t: GrantTranslator, name: string | null | undefined): string {
  const trimmed = name?.trim()
  return trimmed ? trimmed : t("org.grantScope.thisProject")
}
