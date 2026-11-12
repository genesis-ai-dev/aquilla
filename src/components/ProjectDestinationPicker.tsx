/**
 * AQU-1352 P0 (spec 3.5 / 3.9 rule 5) — "where does this project live?"
 *
 * Rendered at the top of ProjectCreateDialog. Lists every destination the
 * caller may create into (GET /api/v2/me/create-targets) and defaults to the
 * page's org when that is valid, else Personal. A user who is org Guest +
 * team Owner (Tim) gets a one-line hint instead of a 403 on submit.
 */
import { useEffect, useState } from "react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { useT } from "@/lib/i18n/I18nProvider"
import { useActiveOrgOptional } from "@/context/OrgContext"
import { resolveRoleName } from "@/lib/frontier/roles"
import { fetchCreateTargets, type CreateTarget } from "@/lib/sync/create-targets"

/**
 * The orgId to POST (undefined = personal; server lazy-creates it), plus the
 * caller's org role and creatable teams there (AQU-1352 P2).
 */
export type Destination = {
  orgId: number | undefined
  /** Display name of the destination, for the success toast. */
  name: string
  role?: number
  teams?: CreateTarget["teams"]
}

const destinationOf = (target: CreateTarget): Destination => ({
  orgId: target.kind === "personal" ? undefined : (target.orgId ?? undefined),
  name: target.name,
  role: target.role,
  teams: target.teams ?? [],
})

const PERSONAL = "personal"
const keyOf = (target: CreateTarget) => (target.kind === "personal" ? PERSONAL : `org:${target.orgId}`)

interface ProjectDestinationPickerProps {
  jwt: string | undefined
  /** The org the page is scoped to (the dialog's `orgId` prop). */
  pageOrgId?: number
  /**
   * Fires once targets load (with the default) and on every change. Fires
   * null when a (re)load starts or fails, so the dialog can never submit a
   * choice made against a previous page org or a previous open.
   */
  onChange: (destination: Destination | null) => void
  /** AQU-1519: locked while the create dialog is working. */
  disabled?: boolean
}

export function ProjectDestinationPicker({
  jwt,
  pageOrgId,
  onChange,
  disabled = false,
}: ProjectDestinationPickerProps) {
  const t = useT()
  const orgCtx = useActiveOrgOptional()
  const [targets, setTargets] = useState<CreateTarget[] | null>(null)
  const [selected, setSelected] = useState<string>(PERSONAL)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    // AQU-1352 review: drop any previous choice before (re)loading.
    setTargets(null)
    setLoadFailed(false)
    onChange(null)
    if (!jwt) return
    let cancelled = false
    fetchCreateTargets(jwt)
      .then((list) => {
        if (cancelled) return
        const pageTarget = list.find((x) => x.orgId != null && x.orgId === pageOrgId)
        const initial = pageTarget ?? list.find((x) => x.kind === "personal") ?? list[0]
        setTargets(list)
        if (!initial) return
        setSelected(keyOf(initial))
        onChange(destinationOf(initial))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // No silent fallback to the page org: submit stays disabled.
        setLoadFailed(true)
        onChange(null)
        console.warn("[project-create] create-targets fetch failed:", err)
      })
    return () => {
      cancelled = true
    }
    // onChange is a setState-style callback; re-fetching on its identity
    // would loop. The fetch depends only on who is asking and from where.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, pageOrgId])

  if (loadFailed) {
    return (
      <p role="alert" className="text-xs text-destructive" data-testid="project-create-destination-error">
        {t("projectSettings.create.destinationLoadError")}
      </p>
    )
  }
  if (!targets || targets.length === 0) return null

  const labelOf = (x: CreateTarget) =>
    x.kind === "personal" ? t("projectSettings.create.destinationPersonal") : x.path.join(" / ")

  const pageOrgInvalid =
    pageOrgId != null && !targets.some((x) => x.orgId === pageOrgId)
  // The page org is absent from create-targets, so the response carries no
  // role for it; use the org context when it knows one, else a generic line.
  const membership = pageOrgInvalid ? orgCtx?.orgs.find((o) => o.id === pageOrgId) : undefined
  const pageRoleLabel = membership ? resolveRoleName(t, membership.role.level) : null
  const pageOrgName =
    orgCtx?.orgs.find((o) => o.id === pageOrgId)?.name ??
    orgCtx?.guestOrgs.find((o) => o.id === pageOrgId)?.name ??
    null

  return (
    <Field>
      <FieldLabel htmlFor="project-create-destination">
        {t("projectSettings.create.destinationLabel")}
      </FieldLabel>
      <Select
        items={targets.map((x) => ({ value: keyOf(x), label: labelOf(x) }))}
        value={selected}
        disabled={disabled}
        onValueChange={(value) => {
          if (!value) return
          const target = targets.find((x) => keyOf(x) === value)
          if (!target) return
          setSelected(value)
          onChange(destinationOf(target))
        }}
      >
        <SelectTrigger id="project-create-destination" data-testid="project-create-destination">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {targets.map((x) => (
              <SelectItem key={keyOf(x)} value={keyOf(x)}>
                {labelOf(x)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {pageOrgInvalid && (
        <FieldDescription data-testid="project-create-destination-hint">
          {pageRoleLabel
            ? t("projectSettings.create.destinationRoleHint", {
                role: pageRoleLabel,
                org: pageOrgName ?? t("projectSettings.create.destinationThisOrg"),
              })
            : t("projectSettings.create.destinationNotAllowedHint", {
                org: pageOrgName ?? t("projectSettings.create.destinationThisOrg"),
              })}
        </FieldDescription>
      )}
    </Field>
  )
}
