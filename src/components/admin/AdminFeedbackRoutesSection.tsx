import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Section } from "@/components/ui/page"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { SearchSelect } from "@/components/ui/search-select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { AdminSectionSkeleton } from "./shared"
import {
  createAdminFeedbackRoute,
  deleteAdminFeedbackRoute,
  getAdminFeedbackRoutes,
  getAdminOrgs,
  getAdminProjects,
  updateAdminFeedbackRoute,
  type AdminFeedbackRoute,
  type AdminOrg,
  type AdminProject,
} from "@/lib/frontier/admin"

const MAX_EMAILS = 10
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/

/** Split a textarea into addresses: one per line, or separated by commas. */
export function parseEmailList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[\n,;]+/)) {
    const email = part.trim().toLowerCase()
    if (email && !seen.has(email)) {
      seen.add(email)
      out.push(email)
    }
  }
  return out
}

interface Draft {
  id: number | null
  orgId: string
  scope: "org" | "projects"
  projectIds: string[]
  emails: string
  label: string
  enabled: boolean
}

const EMPTY_DRAFT: Draft = {
  id: null,
  orgId: "",
  scope: "org",
  projectIds: [],
  emails: "",
  label: "",
  enabled: true,
}

/**
 * Platform-admin "Feedback routing": who is emailed when a user sends "Report
 * a problem". A route is an org (the whole org, or chosen projects) and up to
 * ten addresses. Reports still go to Discord; routes add email on top.
 */
export function AdminFeedbackRoutesSection({ jwt }: { jwt: string }) {
  const [routes, setRoutes] = useState<AdminFeedbackRoute[] | null>(null)
  const [orgs, setOrgs] = useState<AdminOrg[]>([])
  const [projects, setProjects] = useState<AdminProject[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [r, o, p] = await Promise.all([
        getAdminFeedbackRoutes(jwt),
        getAdminOrgs(jwt),
        getAdminProjects(jwt),
      ])
      if (!aliveRef.current) return
      setRoutes(r)
      setOrgs(o)
      setProjects(p)
      setError(null)
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [jwt])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
      return true
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [refresh])

  if (!routes && !error) return <AdminSectionSkeleton label="Loading feedback routes" blocks={2} />
  if (!routes) return <p className="text-sm text-destructive">{error}</p>

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Reports still go to Discord. A route also emails the report to the addresses you list when it
        comes from that org, or from the projects you pick.
      </p>

      <Section title="Routes" description="Every route, with where it applies and who gets the mail.">
        {routes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No routes yet.</p>
        ) : (
          <ul className="divide-y">
            {routes.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 space-y-0.5 text-sm">
                  <div className="font-medium">
                    {r.orgName ?? `Org ${r.orgId}`}
                    {r.label ? <span className="font-normal text-muted-foreground"> · {r.label}</span> : null}
                  </div>
                  <div className="text-muted-foreground" title={r.projects.map((p) => p.name).join(", ")}>
                    {r.projectIds.length === 0
                      ? "Whole org"
                      : `${r.projectIds.length} project${r.projectIds.length === 1 ? "" : "s"}`}
                  </div>
                  <div className="break-all text-xs text-muted-foreground">{r.emails.join(", ")}</div>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={r.enabled}
                    disabled={busy}
                    onCheckedChange={(enabled) =>
                      void run(() => updateAdminFeedbackRoute(jwt, r.id, { enabled }))
                    }
                    aria-label={`enable route ${r.id}`}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setDraft({
                        id: r.id,
                        orgId: String(r.orgId),
                        scope: r.projectIds.length === 0 ? "org" : "projects",
                        projectIds: r.projectIds,
                        emails: r.emails.join("\n"),
                        label: r.label ?? "",
                        enabled: r.enabled,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("Delete this route?")) void run(() => deleteAdminFeedbackRoute(jwt, r.id))
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!draft && (
          <div className="pt-3">
            <Button type="button" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              Add route
            </Button>
          </div>
        )}
      </Section>

      {draft && (
        <RouteForm
          draft={draft}
          setDraft={setDraft}
          orgs={orgs}
          projects={projects}
          busy={busy}
          onCancel={() => setDraft(null)}
          onSave={async (input) => {
            const ok = await run(() =>
              draft.id === null
                ? createAdminFeedbackRoute(jwt, input)
                : updateAdminFeedbackRoute(jwt, draft.id, {
                    projectIds: input.projectIds,
                    emails: input.emails,
                    label: input.label,
                    enabled: input.enabled,
                  }),
            )
            if (ok && aliveRef.current) setDraft(null)
          }}
        />
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

function RouteForm({
  draft,
  setDraft,
  orgs,
  projects,
  busy,
  onCancel,
  onSave,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  orgs: AdminOrg[]
  projects: AdminProject[]
  busy: boolean
  onCancel: () => void
  onSave: (input: {
    orgId: number
    projectIds: string[]
    emails: string[]
    label: string | null
    enabled: boolean
  }) => void
}) {
  const [filter, setFilter] = useState("")
  const orgId = Number(draft.orgId)
  const orgProjects = useMemo(
    () =>
      projects
        .filter((p) => p.orgId === orgId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects, orgId],
  )
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? orgProjects.filter((p) => p.name.toLowerCase().includes(q)) : orgProjects
  }, [orgProjects, filter])

  const emails = parseEmailList(draft.emails)
  const badEmails = emails.filter((e) => !EMAIL_RE.test(e))
  const emailProblem =
    emails.length === 0
      ? "Enter at least one address."
      : emails.length > MAX_EMAILS
        ? `Use at most ${MAX_EMAILS} addresses.`
        : badEmails.length > 0
          ? `Not a valid address: ${badEmails.join(", ")}`
          : null
  const scopeProblem =
    draft.scope === "projects" && draft.projectIds.length === 0 ? "Pick at least one project." : null
  const problem = !draft.orgId ? "Choose an org." : (scopeProblem ?? emailProblem)

  const toggle = (id: string, on: boolean) =>
    setDraft({
      ...draft,
      projectIds: on ? [...new Set([...draft.projectIds, id])] : draft.projectIds.filter((p) => p !== id),
    })
  const shownIds = shown.map((p) => p.id)
  const allShownOn = shownIds.length > 0 && shownIds.every((id) => draft.projectIds.includes(id))

  return (
    <Section title={draft.id === null ? "Add route" : "Edit route"}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="fr-org">Org</FieldLabel>
          <SearchSelect
            id="fr-org"
            className="w-full"
            disabled={draft.id !== null}
            options={[
              { value: "", label: "Choose an org" },
              ...orgs.map((o) => ({ value: String(o.id), label: o.name ?? `Org ${o.id}` })),
            ]}
            value={draft.orgId}
            onValueChange={(v) => setDraft({ ...draft, orgId: v, projectIds: [] })}
          />
        </div>

        <div className="space-y-1.5">
          <FieldLabel>Applies to</FieldLabel>
          <RadioGroup
            value={draft.scope}
            onValueChange={(v) => setDraft({ ...draft, scope: v as Draft["scope"] })}
          >
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="org" /> Whole org
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="projects" /> Selected projects
            </label>
          </RadioGroup>
        </div>

        {draft.scope === "projects" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                aria-label="Filter projects"
                placeholder="Filter projects"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={shownIds.length === 0}
                onClick={() =>
                  setDraft({
                    ...draft,
                    projectIds: allShownOn
                      ? draft.projectIds.filter((id) => !shownIds.includes(id))
                      : [...new Set([...draft.projectIds, ...shownIds])],
                  })
                }
              >
                {allShownOn ? "Clear shown" : "Select all shown"}
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-md border p-2">
              {!draft.orgId ? (
                <p className="text-sm text-muted-foreground">Choose an org first.</p>
              ) : shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects match.</p>
              ) : (
                shown.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 py-1 text-sm">
                    <Checkbox
                      checked={draft.projectIds.includes(p.id)}
                      onCheckedChange={(on) => toggle(p.id, on === true)}
                    />
                    <span className="truncate">{p.name}</span>
                  </label>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">{draft.projectIds.length} selected</p>
          </div>
        )}

        <div className="space-y-1.5">
          <FieldLabel htmlFor="fr-emails">Email addresses</FieldLabel>
          <Textarea
            id="fr-emails"
            rows={4}
            placeholder="One per line, or separated by commas"
            value={draft.emails}
            onChange={(e) => setDraft({ ...draft, emails: e.target.value })}
          />
          {draft.emails.trim() && emailProblem && (
            <p className="text-xs text-destructive">{emailProblem}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <FieldLabel htmlFor="fr-label">Name (optional)</FieldLabel>
          <Input
            id="fr-label"
            maxLength={80}
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            aria-label="route enabled"
          />
          <span>Enabled</span>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            disabled={busy || problem !== null}
            onClick={() =>
              onSave({
                orgId,
                projectIds: draft.scope === "projects" ? draft.projectIds : [],
                emails,
                label: draft.label.trim() || null,
                enabled: draft.enabled,
              })
            }
          >
            {busy ? "Saving…" : "Save route"}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {problem && <span className="text-xs text-muted-foreground">{problem}</span>}
        </div>
      </div>
    </Section>
  )
}
