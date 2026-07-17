// Personal API tokens section for the Preferences page (AQU-533 §1 "Token
// UI"). Lets a signed-in user mint, list, and revoke `aqk_…` personal-access
// tokens for the external Agent API.
//
// Follows UsageSection's fetch-render-in-Section pattern. The mint dialog
// filters org/project choices to what the caller's role actually permits
// (>= CONTRIBUTOR to scope at all, >= MAINTAINER on a project for 'act' mode)
// as a UX courtesy only — the server (auth-worker/src/routes/credentials.ts)
// remains the authority and re-checks everything.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { Copy } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Section } from "@/components/ui/page"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { ROLE } from "@/lib/frontier/roles"
import {
  listCredentials,
  mintCredential,
  revokeCredential,
  type ApiCredential,
  type CredentialMode,
  type MintCredentialResult,
} from "@/lib/sync/credentials"

const EXPIRY_PRESETS = [
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "none", label: "No expiry", days: null },
] as const
type ExpiryPresetId = (typeof EXPIRY_PRESETS)[number]["id"]

function expiryToIso(preset: ExpiryPresetId): string | undefined {
  const days = EXPIRY_PRESETS.find((p) => p.id === preset)?.days
  if (!days) return undefined
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

/** Resolve a credential's org/project scope into a friendly label. Falls back
 * to the raw id when the org/project isn't in the caller's current lists
 * (e.g. access was later revoked). */
function scopeLabel(
  cred: ApiCredential,
  orgs: OrgSummary[],
  projects: CloudProjectSummary[],
): string {
  if (cred.projectId) {
    const p = projects.find((p) => p.id === cred.projectId)
    return p ? p.name : `Project ${cred.projectId}`
  }
  if (cred.orgId) {
    const o = orgs.find((o) => String(o.id) === cred.orgId)
    return o ? (o.name ?? `Org ${o.id}`) : `Org ${cred.orgId}`
  }
  return "Unscoped (personal)"
}

/** Fetches the caller's orgs + accessible projects once, for scope filtering
 * in the mint dialog and name resolution in the list. Swallows errors —
 * scope names just fall back to raw ids if this fails. */
function useOrgsAndProjects(jwt: string | null): {
  orgs: OrgSummary[]
  projects: CloudProjectSummary[]
} {
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])

  useEffect(() => {
    if (!jwt) {
      setOrgs([])
      setProjects([])
      return
    }
    let cancelled = false
    Promise.all([listMyOrgs(jwt), fetchAccessibleProjects(jwt)])
      .then(([o, p]) => {
        if (cancelled) return
        setOrgs(o)
        setProjects(p)
      })
      .catch(() => {
        if (cancelled) return
        setOrgs([])
        setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [jwt])

  return { orgs, projects }
}

export function ApiTokensSection() {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { orgs, projects } = useOrgsAndProjects(jwt)
  const [credentials, setCredentials] = useState<ApiCredential[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [mintResult, setMintResult] = useState<MintCredentialResult | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ApiCredential | null>(null)

  useEffect(() => {
    if (!jwt) {
      setCredentials(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    listCredentials(jwt)
      .then((list) => {
        if (!cancelled) setCredentials(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load tokens.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [jwt, refreshKey])

  if (!jwt) return null

  function refresh() {
    setRefreshKey((k) => k + 1)
  }

  return (
    <Section
      title="API tokens"
      description="Personal access tokens for the Agent API. Anyone holding a token can act with your access, up to its scope — treat it like a password."
      action={
        <MintTokenDialog
          jwt={jwt}
          orgs={orgs}
          projects={projects}
          onMinted={(result) => {
            setMintResult(result)
            refresh()
          }}
        />
      }
    >
      {loading && !credentials ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : !credentials || credentials.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No tokens yet. Mint one to let an agent call the Agent API on your behalf.
        </p>
      ) : (
        <ul className="space-y-2">
          {credentials.map((cred) => (
            <CredentialRow
              key={cred.id}
              credential={cred}
              orgs={orgs}
              projects={projects}
              onRevoke={() => setRevokeTarget(cred)}
            />
          ))}
        </ul>
      )}

      {revokeTarget && (
        <RevokeCredentialDialog
          jwt={jwt}
          credential={revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onRevoked={() => {
            setRevokeTarget(null)
            refresh()
          }}
        />
      )}

      {mintResult && (
        <ShowOnceTokenDialog result={mintResult} onClose={() => setMintResult(null)} />
      )}
    </Section>
  )
}

function CredentialRow({
  credential,
  orgs,
  projects,
  onRevoke,
}: {
  credential: ApiCredential
  orgs: OrgSummary[]
  projects: CloudProjectSummary[]
  onRevoke: () => void
}) {
  const revoked = Boolean(credential.revokedAt)
  const expired =
    !revoked && Boolean(credential.expiresAt) && new Date(credential.expiresAt!).getTime() < Date.now()

  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="text-xs font-mono">{credential.tokenPrefix}…</code>
          <Badge variant={credential.mode === "act" ? "default" : "secondary"}>
            {credential.mode}
          </Badge>
          {revoked && <Badge variant="destructive">Revoked</Badge>}
          {expired && <Badge variant="outline">Expired</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          {credential.name} · {scopeLabel(credential, orgs, projects)}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {credential.expiresAt ? `Expires ${fmtDate(credential.expiresAt)}` : "No expiry"}
          {credential.lastUsedAt ? ` · Last used ${fmtDate(credential.lastUsedAt)}` : ""}
        </p>
      </div>
      {!revoked && (
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRevoke}
        >
          Revoke
        </Button>
      )}
    </li>
  )
}

function RevokeCredentialDialog({
  jwt,
  credential,
  onClose,
  onRevoked,
}: {
  jwt: string
  credential: ApiCredential
  onClose: () => void
  onRevoked: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRevoke() {
    setBusy(true)
    setError(null)
    try {
      await revokeCredential(jwt, credential.id)
      onRevoked()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke token.")
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke token?</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <p className="text-sm">
            <strong>{credential.name}</strong> ({credential.tokenPrefix}…) will stop working
            immediately. This can&apos;t be undone.
          </p>
          {error && <FieldError role="alert">{error}</FieldError>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void handleRevoke()} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" />}
            {busy ? "Revoking…" : "Revoke token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The plaintext token is rendered exactly once, right after mint. It is
 * never stored client-side — this dialog holds the only in-memory copy, and
 * it's gone once closed. */
function ShowOnceTokenDialog({
  result,
  onClose,
}: {
  result: MintCredentialResult
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard.writeText(result.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your new API token</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground" role="alert">
            Copy this now — you will not see it again. If you lose it, revoke this token and
            mint a new one.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">
              {result.token}
            </code>
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="mr-1 size-3.5" />
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MintTokenDialog({
  jwt,
  orgs,
  projects,
  onMinted,
}: {
  jwt: string
  orgs: OrgSummary[]
  projects: CloudProjectSummary[]
  onMinted: (result: MintCredentialResult) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [mode, setMode] = useState<CredentialMode>("ask")
  const [orgId, setOrgId] = useState("")
  const [projectId, setProjectId] = useState("")
  const [expiry, setExpiry] = useState<ExpiryPresetId>("90d")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Re-entrancy guard: `busy` state only disables the submit button after a
  // re-render, so a fast double-click or double Enter can fire handleSubmit twice
  // before that lands — minting two credentials. This ref flips synchronously.
  const submittingRef = useRef(false)

  // Scope choices are capped to what the caller can actually use: >= CONTRIBUTOR
  // to scope a credential at all (matches the server's scope_denied rule).
  const orgOptions = useMemo(
    () => orgs.filter((o) => o.role.level >= ROLE.CONTRIBUTOR),
    [orgs],
  )
  const projectOptions = useMemo(
    () =>
      projects.filter(
        (p) => p.role.level >= ROLE.CONTRIBUTOR && (!orgId || String(p.orgId ?? "") === orgId),
      ),
    [projects, orgId],
  )
  const selectedProject = projectOptions.find((p) => p.id === projectId) ?? null
  // Act mode requires a project scope where the caller is >= MAINTAINER —
  // disabled (not just server-rejected) until that's true, per spec §1.
  const canAct = selectedProject != null && selectedProject.role.level >= ROLE.MAINTAINER

  useEffect(() => {
    if (open) return
    setName("")
    setMode("ask")
    setOrgId("")
    setProjectId("")
    setExpiry("90d")
    setError(null)
    setBusy(false)
  }, [open])

  // Drop a project selection that fell out of the current org filter.
  useEffect(() => {
    setProjectId((cur) => (projectOptions.some((p) => p.id === cur) ? cur : ""))
  }, [projectOptions])

  // Drop back to ask if the eligible project was cleared out from under act mode.
  useEffect(() => {
    if (mode === "act" && !canAct) setMode("ask")
  }, [mode, canAct])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    // Drop re-entrant submits (double-click / double Enter) while a mint is in
    // flight, before `busy` has re-rendered the button to disabled.
    if (submittingRef.current) return
    if (!name.trim()) {
      setError("Give this token a name.")
      return
    }
    submittingRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await mintCredential(jwt, {
        name: name.trim(),
        mode,
        orgId: orgId || undefined,
        projectId: projectId || undefined,
        expiresAt: expiryToIso(expiry),
      })
      onMinted(result)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mint token.")
    } finally {
      submittingRef.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>New token</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New API token</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="contents">
          <DialogBody className="space-y-4">
            <Field>
              <FieldLabel htmlFor="token-name">Name</FieldLabel>
              <Input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Import agent"
              />
            </Field>

            <Field>
              <FieldLabel>Mode</FieldLabel>
              <RadioGroup
                value={mode}
                onValueChange={(value) => setMode(value as CredentialMode)}
                className="gap-2"
              >
                <label className="flex items-start gap-2.5 text-sm">
                  <RadioGroupItem value="ask" className="mt-0.5" />
                  <span>
                    <strong>Ask</strong> — every write waits for your approval.
                  </span>
                </label>
                <label
                  className={`flex items-start gap-2.5 text-sm ${!canAct ? "opacity-50" : ""}`}
                >
                  <RadioGroupItem value="act" className="mt-0.5" disabled={!canAct} />
                  <span>
                    <strong>Act</strong> — writes apply immediately. Requires a project below
                    where you&apos;re a maintainer.
                  </span>
                </label>
              </RadioGroup>
            </Field>

            <Field>
              <FieldLabel htmlFor="token-org">Organization</FieldLabel>
              <Select value={orgId} onValueChange={(value) => setOrgId(value ?? "")}>
                <SelectTrigger id="token-org" className="w-full">
                  <SelectValue placeholder="No organization (personal)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {orgOptions.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>
                        {o.name ?? `Org ${o.id}`}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Only orgs where you&apos;re at least a contributor are listed.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="token-project">Project</FieldLabel>
              <Select value={projectId} onValueChange={(value) => setProjectId(value ?? "")}>
                <SelectTrigger id="token-project" className="w-full">
                  <SelectValue placeholder="No project (org-wide)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {projectOptions.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="token-expiry">Expiry</FieldLabel>
              <Select
                value={expiry}
                onValueChange={(value) => setExpiry((value ?? "90d") as ExpiryPresetId)}
              >
                <SelectTrigger id="token-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {EXPIRY_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {error && <FieldError role="alert">{error}</FieldError>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {busy ? "Minting…" : "Mint token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
