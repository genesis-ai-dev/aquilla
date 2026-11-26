/**
 * AQU-2320: one dialog for every grant — "Give [person] the role [role] at
 * [place]". Opened from the Places lens header; any blank can arrive
 * pre-filled, so later slices (person inspector, remove dialog, lane
 * narrowing) open the same dialog instead of building their own.
 *
 * The primary button stays disabled until the server's dry run answers for
 * exactly the sentence on screen. Submitting writes ONE grant through the
 * route that already owns that kind of place (give-access-data.ts).
 */
import { useEffect, useState } from "react"
import { UserPlus } from "lucide-react"

import { roleLabel } from "@/components/access/labels"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { toast } from "@/components/ui/toast"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  placeBlock,
  placeRows,
  previewRequest,
  roleOptions,
  roleReset,
  type PersonChoice,
  type PlaceRow,
  type RoleReset,
} from "@/lib/access/give-access"
import { placeParam } from "@/lib/access/place-lens"
import { formatScopePath } from "@/lib/access/scope-path"
import type { ScopePath, ScopeType } from "@/lib/access/types"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

import { fetchGrantPreview, submitGrant } from "./give-access-data"
import { PersonBlank, PlaceBlank, RoleBlank } from "./GiveAccessPickers"
import { GrantPreviewPanel, type PreviewState } from "./GrantPreviewPanel"
import type { OrgAccessPayload } from "./org-access-data"

export type GiveAccessPersonRef = { userId: string } | { email: string }

export interface GiveAccessDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: number
  /** The Places/People payload: tree, people and the `grantable` map. */
  payload: OrgAccessPayload
  initialPerson?: GiveAccessPersonRef
  initialRoleLevel?: number
  initialPlace?: { type: ScopeType; id: string }
  /** After the write succeeded. The page reloads the lens here. */
  onGranted?: (grant: { person: PersonChoice; roleLevel: number; path: ScopePath }) => void
}

export function GiveAccessDialog({ open, onOpenChange, ...rest }: GiveAccessDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Closed is unmounted: every open starts from the pre-filled props. */}
      {open && (
        <DialogContent data-testid="give-access-dialog" className="sm:max-w-xl">
          <GiveAccessBody {...rest} onClose={() => onOpenChange(false)} />
        </DialogContent>
      )}
    </Dialog>
  )
}

function resolvePerson(payload: OrgAccessPayload, ref: GiveAccessPersonRef | undefined): PersonChoice | null {
  if (!ref) return null
  if ("email" in ref) return { kind: "invite", email: ref.email.trim().toLowerCase() }
  const p = payload.people.find((person) => person.userId === ref.userId && !person.pendingInvite)
  return p ? { kind: "account", userId: p.userId, displayName: p.displayName, username: p.username ?? null, email: p.email ?? null, isGuest: p.isGuest } : null
}

function resetText(t: TFunction, reset: RoleReset): string {
  const role = roleLabel(t, reset.roleLevel)
  if (reset.reason === "not_offered") {
    // "Organization" is onboarding.apiTokens.orgLabel, as in PlacesLens' PLACE_KIND.
    const place = reset.place === "org" ? t("onboarding.apiTokens.orgLabel") : t(`org.access.scope.${reset.place}`)
    return t("org.access.give.reset.not_offered", { role, place })
  }
  return t(`org.access.give.reset.${reset.reason}`, { role, cap: roleLabel(t, reset.cap) })
}

function GiveAccessBody({
  orgId,
  payload,
  initialPerson,
  initialRoleLevel,
  initialPlace,
  onGranted,
  onClose,
}: Omit<GiveAccessDialogProps, "open" | "onOpenChange"> & { onClose: () => void }) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [rows] = useState(() => placeRows(payload.tree, payload.grantable))
  const [person, setPerson] = useState<PersonChoice | null>(() => resolvePerson(payload, initialPerson))
  const [place, setPlace] = useState<PlaceRow | null>(() => {
    const row = initialPlace ? rows.find((r) => r.key === placeParam(initialPlace)) : undefined
    return row && placeBlock(row, resolvePerson(payload, initialPerson)) == null ? row : null
  })
  const [role, setRole] = useState<number | null>(() => {
    if (initialRoleLevel == null) return null
    const options = roleOptions(rows, place, person)
    return options.includes(initialRoleLevel) ? initialRoleLevel : null
  })
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(false)

  /** A place or person change may leave the chosen role unoffered: clear it and say why. */
  const recheck = (nextPerson: PersonChoice | null, nextPlace: PlaceRow | null) => {
    if (role == null || nextPlace == null) return
    const reset = roleReset(role, nextPlace, nextPerson)
    if (reset) {
      setRole(null)
      setNotice(resetText(t, reset))
    }
  }
  const choosePerson = (next: PersonChoice) => {
    setPerson(next)
    // An invite cannot go to a team: that place is no longer valid.
    const keptPlace = place && placeBlock(place, next) == null ? place : null
    setPlace(keptPlace)
    recheck(next, keptPlace)
  }
  const choosePlace = (next: PlaceRow) => {
    setPlace(next)
    setNotice(null)
    recheck(person, next)
  }
  const chooseRole = (next: number) => {
    setRole(next)
    setNotice(null)
  }

  const request = person && role != null && place ? previewRequest(person, role, place) : null
  const sig = request ? JSON.stringify(request) : null
  const [answer, setAnswer] = useState<{ sig: string; state: PreviewState } | null>(null)
  useEffect(() => {
    if (!sig || !jwt) return
    let cancelled = false
    fetchGrantPreview(jwt, orgId, JSON.parse(sig) as unknown).then(
      (result) => {
        if (cancelled) return
        setAnswer({ sig, state: result.ok ? { status: "ready", preview: result.preview } : { status: "refused", message: result.refused.message } })
      },
      () => { if (!cancelled) setAnswer({ sig, state: { status: "error" } }) },
    )
    return () => { cancelled = true }
  }, [sig, jwt, orgId])
  // An answer for an earlier sentence is never shown against the current one.
  const preview: PreviewState = !sig ? { status: "idle" } : answer?.sig === sig ? answer.state : { status: "loading" }
  const ready = preview.status === "ready" && person != null && role != null && place != null

  const submit = async () => {
    if (!ready || !jwt || submitting) return
    setSubmitting(true)
    setSubmitError(false)
    try {
      await submitGrant(jwt, orgId, { person, roleLevel: role, place })
      const path = formatScopePath(place.path)
      toast.add({
        type: "success",
        title: person.kind === "invite"
          ? t("org.access.give.invited", { email: person.email, role: roleLabel(t, role), path })
          : t("org.access.give.done", { name: person.displayName, role: roleLabel(t, role), path }),
      })
      onGranted?.({ person, roleLevel: role, path: place.path })
      onClose()
    } catch {
      setSubmitError(true)
      setSubmitting(false)
    }
  }

  const personPlaceKeys = new Set(
    person?.kind === "account"
      ? (payload.people.find((p) => p.userId === person.userId)?.grants ?? []).flatMap((g) => {
          const last = g.scopePath[g.scopePath.length - 1]
          return last ? [placeParam(last)] : []
        })
      : [],
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("org.access.give.title")}</DialogTitle>
        <DialogDescription>{t("org.access.give.description")}</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex min-w-0 flex-col gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm" data-testid="give-sentence">
          <span>{t("org.access.give.wordGive")}</span>
          <PersonBlank people={payload.people} value={person} onChange={choosePerson} />
          <span>{t("org.access.give.wordRole")}</span>
          <RoleBlank options={roleOptions(rows, place, person)} value={role} onChange={chooseRole} />
          <span>{t("org.access.give.wordAt")}</span>
          <PlaceBlank rows={rows} value={place} person={person} personPlaceKeys={personPlaceKeys} onChange={choosePlace} />
        </p>
        {notice && <p role="status" data-testid="give-role-notice" className="text-sm text-muted-foreground">{notice}</p>}
        <GrantPreviewPanel state={preview} email={person?.kind === "invite" ? person.email : null} />
        {submitError && <p role="alert" className="text-sm text-destructive">{t("org.access.give.submitError")}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="button" onClick={() => void submit()} disabled={!ready || submitting} data-testid="give-access-submit">
          <UserPlus aria-hidden />
          {person?.kind === "invite" ? t("org.access.give.submitInvite") : t("org.access.give.submit")}
        </Button>
      </DialogFooter>
    </>
  )
}
