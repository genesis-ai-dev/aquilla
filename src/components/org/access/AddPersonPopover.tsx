/**
 * The "add person" button at the end of a folder row in People & access. It
 * opens a popover on that place: pick a person (or type an email to invite
 * someone), pick one of the roles this kind of place takes, up to the
 * viewer's own role there, and add them. The writes are the same ones the
 * Give access dialog makes (`submitGrant`), so the server rules are the same.
 */
import { useState } from "react"
import { UserPlus } from "lucide-react"

import { roleLabel } from "@/components/access/labels"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { toast } from "@/components/ui/toast"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { inviteEmail, type PersonChoice, type PlaceRow } from "@/lib/access/give-access"
import { offeredRoles } from "@/lib/access/grant-rules"
import { formatScopePath } from "@/lib/access/scope-path"
import { useT } from "@/lib/i18n/I18nProvider"

import { submitGrant } from "./give-access-data"
import type { OrgAccessPerson } from "./org-access-data"

const ROLE_BLURB = {
  700: "org.access.tree.roleBlurb.700",
  600: "org.access.tree.roleBlurb.600",
  500: "org.access.tree.roleBlurb.500",
  400: "org.access.tree.roleBlurb.400",
  300: "org.access.tree.roleBlurb.300",
  200: "org.access.tree.roleBlurb.200",
  100: "org.access.tree.roleBlurb.100",
} as const

/** The role picked first when the popover opens, if the viewer may give it. */
const DEFAULT_ROLE = { org: 600, team: 500, project: 400, lane: 400 } as const

export function AddPersonPopover({
  orgId,
  place,
  people,
  onGranted,
}: {
  orgId: number
  /** The place, with the viewer's grantability there. Only rendered where it is ok. */
  place: PlaceRow
  people: readonly OrgAccessPerson[]
  onGranted: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const name = place.scope.name
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="outline" size="icon-sm" />}
        aria-label={t("org.access.addPeopleTo", { path: name })}
        data-testid="folder-add-person"
      >
        <UserPlus aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3" data-testid="add-person-popover">
        {open && <AddPersonForm orgId={orgId} place={place} people={people} onDone={() => { setOpen(false); onGranted() }} />}
      </PopoverContent>
    </Popover>
  )
}

function AddPersonForm({
  orgId,
  place,
  people,
  onDone,
}: {
  orgId: number
  place: PlaceRow
  people: readonly OrgAccessPerson[]
  onDone: () => void
}) {
  const t = useT()
  const { session } = useFrontierSession()
  const [query, setQuery] = useState("")
  const [person, setPerson] = useState<PersonChoice | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)

  const type = place.scope.type
  const cap = place.grantable.ok ? place.grantable.cap : 0
  const roles = offeredRoles(type, cap, { invite: person?.kind === "invite" })
  const fallback = roles.includes(DEFAULT_ROLE[type]) ? DEFAULT_ROLE[type] : roles[roles.length - 1] ?? null
  const role = picked != null && roles.includes(picked) ? picked : fallback

  const q = query.trim().toLowerCase()
  const accounts = people.filter((p) => !p.pendingInvite)
  const matches = (q
    ? accounts.filter((p) => p.displayName.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q))
    : accounts
  ).slice(0, 50)
  const email = inviteEmail(query)
  const offerInvite = email != null && !accounts.some((p) => p.email?.toLowerCase() === email)

  const submit = async () => {
    if (!session?.jwt || !person || role == null || submitting) return
    setSubmitting(true)
    setFailed(false)
    try {
      await submitGrant(session.jwt, orgId, { person, roleLevel: role, place })
      const path = formatScopePath(place.path)
      toast.add({
        type: "success",
        title: person.kind === "invite"
          ? t("org.access.give.invited", { email: person.email, role: roleLabel(t, role), path })
          : t("org.access.give.done", { name: person.displayName, role: roleLabel(t, role), path }),
      })
      onDone()
    } catch {
      setFailed(true)
      setSubmitting(false)
    }
  }

  const chosen = person == null ? null : person.kind === "invite" ? person.email : person.displayName
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{t("org.access.addPeopleTo", { path: place.scope.name })}</p>
        <p className="text-xs text-muted-foreground">{t(`org.access.tree.addHint.${type}`)}</p>
      </div>
      {chosen == null ? (
        <Command shouldFilter={false} className="rounded-md border">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("org.access.give.personSearch")}
            aria-label={t("org.access.give.personSearch")}
            autoFocus
          />
          <CommandList className="max-h-48">
            {matches.length === 0 && !offerInvite && <CommandEmpty>{t("org.access.give.noPeople")}</CommandEmpty>}
            {offerInvite && (
              <CommandItem value={`invite:${email}`} onSelect={() => setPerson({ kind: "invite", email })}>
                <UserPlus aria-hidden />
                {t("org.access.give.inviteEmail", { email })}
              </CommandItem>
            )}
            {matches.map((p) => (
              <CommandItem
                key={p.userId}
                value={`person:${p.userId}`}
                onSelect={() => setPerson({
                  kind: "account",
                  userId: p.userId,
                  displayName: p.displayName,
                  username: p.username ?? null,
                  email: p.email ?? null,
                  isGuest: p.isGuest,
                })}
              >
                <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
                {p.email && p.email !== p.displayName && <span className="truncate text-xs text-muted-foreground">{p.email}</span>}
                {p.isGuest && <Badge variant="outline">{t("org.access.inspector.guest")}</Badge>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      ) : (
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm">
          <span className="min-w-0 truncate font-medium" data-testid="add-person-chosen">{chosen}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setPerson(null); setFailed(false) }}>
            {t("org.access.tree.changePerson")}
          </Button>
        </div>
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">{t("org.access.give.roleLabel")}</legend>
        {roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("org.access.give.noRoles")}</p>
        ) : (
          <RadioGroup value={role == null ? "" : String(role)} onValueChange={(value) => setPicked(Number(value))} className="gap-0.5">
            {roles.map((level) => (
              <label
                key={level}
                data-role-level={level}
                className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/50 has-data-checked:bg-accent"
              >
                <RadioGroupItem value={String(level)} className="mt-0.5" />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{roleLabel(t, level)}</span>
                  <span className="text-xs text-muted-foreground">{level in ROLE_BLURB ? t(ROLE_BLURB[level as keyof typeof ROLE_BLURB]) : null}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        )}
      </fieldset>
      {failed && <p role="alert" className="text-sm text-destructive">{t("org.access.tree.addFailed")}</p>}
      <Button type="button" disabled={!person || role == null || submitting} onClick={() => void submit()} data-testid="add-person-submit">
        {role == null ? t("org.access.give.roleBlank") : t("org.access.tree.addAs", { role: roleLabel(t, role) })}
      </Button>
    </div>
  )
}
