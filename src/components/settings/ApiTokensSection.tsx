import { AUTH_BASE } from "@/lib/frontier/auth"
import { buildConnectionInstructions } from "@/lib/sync/agent-connect"
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
import { Copy, ShieldAlert } from "lucide-react"
import { buildAgentInstructions } from "@/lib/sync/agent-instructions"
import { useT } from "@/lib/i18n/I18nProvider"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { CredentialRow } from "./CredentialRow"
import { scopeLabel } from "./credential-scope"
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
import { Checkbox } from "@/components/ui/checkbox"
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
import { SettingsGroup, SettingsRow } from "@/components/ui/page"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import {
  fetchAccessibleProjectsResult,
  projectsResultError,
  type CloudProjectSummary,
} from "@/lib/sync/cloud-projects"
import { ROLE } from "@/lib/frontier/roles"
import { toUserFacingError, UserError } from "@/lib/errors/user-error"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import {
  listCredentials,
  mintCredential,
  revokeCredential,
  type ApiCredential,
  type CredentialMode,
  type MintCredentialResult,
} from "@/lib/sync/credentials"

/** MessageKey, without importing from the generated catalog — see LeftDock.tsx. */
type TokenMessageKey = Parameters<ReturnType<typeof useT>>[0]

/** ~15s of polling at 2.5s, which comfortably covers the agent's 5s poll
 * interval plus a slow mint, without becoming a background refresher. */
const AWAIT_GRANT_ATTEMPTS = 6
const AWAIT_GRANT_INTERVAL_MS = 2500

const EXPIRY_PRESETS = [
  { id: "30d", labelKey: "common.thirtyDays", days: 30 },
  { id: "90d", labelKey: "onboarding.apiTokens.expiry.90d", days: 90 },
  { id: "none", labelKey: "common.noExpiry", days: null },
] as const satisfies readonly { id: string; labelKey: TokenMessageKey; days: number | null }[]
type ExpiryPresetId = (typeof EXPIRY_PRESETS)[number]["id"]

function expiryToIso(preset: ExpiryPresetId): string | undefined {
  const days = EXPIRY_PRESETS.find((p) => p.id === preset)?.days
  if (!days) return undefined
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

/** Fetches the caller's orgs + accessible projects for scope filtering and
 * name resolution. Failures stay explicit so an unavailable directory cannot
 * masquerade as an account with no scope choices. */
function useOrgsAndProjects(jwt: string | null): {
  orgs: OrgSummary[]
  projects: CloudProjectSummary[]
  isLoading: boolean
  error: string | null
  retry: () => void
} {
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!jwt) {
      setOrgs([])
      setProjects([])
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([listMyOrgs(jwt), fetchAccessibleProjectsResult(jwt)])
      .then(([o, result]) => {
        if (cancelled) return
        if (!result.ok) {
          if (result.reason === "unauthenticated") void notifySessionExpiredIfCurrent(jwt)
          throw projectsResultError(result)
        }
        setOrgs(o)
        setProjects(result.projects)
        setError(null)
      })
      .catch((error) => {
        if (cancelled) return
        if (error instanceof UserError && error.category === "session-expired") {
          void notifySessionExpiredIfCurrent(jwt)
        }
        setOrgs([])
        setProjects([])
        setError(toUserFacingError(error, "token scopes").message)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true
    }
  }, [jwt, refreshKey])

  return { orgs, projects, isLoading, error, retry: () => setRefreshKey((key) => key + 1) }
}

export function ApiTokensSection() {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const {
    orgs,
    projects,
    isLoading: scopesLoading,
    error: scopesError,
    retry: retryScopes,
  } = useOrgsAndProjects(jwt)
  const [credentials, setCredentials] = useState<ApiCredential[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [mintResult, setMintResult] = useState<MintCredentialResult | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ApiCredential | null>(null)
  const [connectionCopied, setConnectionCopied] = useState(false)
  const [connectionCopyError, setConnectionCopyError] = useState(false)
  const connectionInstructions = buildConnectionInstructions(AUTH_BASE, syncWorkerHttpOrigin())
  const [instructionsFor, setInstructionsFor] = useState<ApiCredential | null>(null)
  // Arriving from /connect-agent, the credential does not exist yet: it is
  // minted on the agent's NEXT poll of the token endpoint, up to `interval`
  // seconds after approval. A single fetch on mount is therefore reliably too
  // early. Refetch a few times, then stop — this is a startup race, not a
  // surface that needs live updates.
  // Read once from the URL rather than through the router: this is a one-shot
  // arrival signal, and the section is rendered in tests without a Router.
  const [attemptsLeft, setAttemptsLeft] = useState(() =>
    new URLSearchParams(window.location.search).get("awaiting") === "1" ? AWAIT_GRANT_ATTEMPTS : 0,
  )
  const knownCount = credentials?.length ?? null
  useEffect(() => {
    if (attemptsLeft <= 0) return
    const timer = setTimeout(() => {
      setAttemptsLeft((n) => n - 1)
      setRefreshKey((k) => k + 1)
    }, AWAIT_GRANT_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [attemptsLeft, knownCount])
  // The new token is the newest row; stop polling as soon as one shows up.
  const firstCount = useRef<number | null>(null)
  useEffect(() => {
    if (knownCount == null) return
    if (firstCount.current == null) firstCount.current = knownCount
    else if (knownCount > firstCount.current) setAttemptsLeft(0)
  }, [knownCount])

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
        if (!cancelled) setError(err instanceof Error ? err.message : t("onboarding.apiTokens.loadFailed"))
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
    <div className="space-y-2">
      <SettingsGroup><SettingsRow label={t("onboarding.connect.setup")} block>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("onboarding.connect.setupBody")}</p>
          <Button variant="outline" onClick={async () => {
            try { await navigator.clipboard.writeText(connectionInstructions); setConnectionCopied(true); setConnectionCopyError(false) }
            catch { setConnectionCopyError(true) }
          }}>{connectionCopied ? t("nav.version.copiedLabel") : t("onboarding.connect.copy")}</Button>
          {connectionCopyError && <><p role="alert">{t("onboarding.connect.copyError")}</p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{connectionInstructions}</pre></>}
        </div>
      </SettingsRow></SettingsGroup>
      <div className="flex items-center justify-between gap-4 pl-4">
        <p className="font-heading text-base font-medium tracking-tight text-foreground">
          {t("onboarding.apiTokens.heading")}
        </p>
        <MintTokenDialog
          jwt={jwt}
          orgs={orgs}
          projects={projects}
          disabled={scopesLoading || scopesError != null}
          onMinted={(result) => {
            setMintResult(result)
            refresh()
          }}
        />
      </div>
      {scopesError && (
        <div className="flex items-center gap-2 px-4 text-xs text-destructive" role="alert">
          <span>{scopesError}</span>
          <Button type="button" size="xs" variant="ghost" onClick={retryScopes}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      <SettingsGroup>
        <SettingsRow label={t("onboarding.apiTokens.yourTokensLabel")} block>
          {loading && !credentials ? (
            <div className="flex items-center text-muted-foreground">
              <Spinner className="size-3.5" />
            </div>
          ) : error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : !credentials || credentials.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("onboarding.apiTokens.empty")}
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
                  onShowInstructions={() => setInstructionsFor(cred)}
                />
              ))}
            </ul>
          )}
        </SettingsRow>
      </SettingsGroup>

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

      {instructionsFor && (
        <AgentInstructionsDialog
          mode={instructionsFor.mode}
          scopeLabel={scopeLabel(t, instructionsFor, orgs, projects)}
          onClose={() => setInstructionsFor(null)}
        />
      )}

      {mintResult && (
        <ShowOnceTokenDialog
          result={mintResult}
          scopeLabel={scopeLabel(t, mintResult.credential, orgs, projects)}
          onClose={() => setMintResult(null)}
        />
      )}
    </div>
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
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRevoke() {
    setBusy(true)
    setError(null)
    try {
      await revokeCredential(jwt, credential.id)
      onRevoked()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("onboarding.apiTokens.revokeFailed"))
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
          <DialogTitle>{t("onboarding.apiTokens.revokeDialogTitle")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <p className="text-sm">
            <strong>{credential.name}</strong>{" "}
            {t("onboarding.apiTokens.revokeWarning", { prefix: credential.tokenPrefix })}
          </p>
          {error && <FieldError role="alert">{error}</FieldError>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void handleRevoke()} disabled={busy}>
            {busy && <Spinner data-icon="inline-start" />}
            {busy ? t("common.revoking") : t("onboarding.apiTokens.revokeTokenButton")}
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
  scopeLabel,
  onClose,
}: {
  result: MintCredentialResult
  scopeLabel: string
  onClose: () => void
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [copiedPrompt, setCopiedPrompt] = useState(false)

  function copy() {
    void navigator.clipboard.writeText(result.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Copies the token *inside* a ready-to-paste prompt. This is the only moment
  // we hold the plaintext, so it's the only moment the prompt can be complete.
  function copyInstructions() {
    void navigator.clipboard.writeText(
      buildAgentInstructions({
        syncOrigin: syncWorkerHttpOrigin(),
        token: result.token,
        mode: result.credential.mode,
        scopeLabel,
      }),
    )
    setCopiedPrompt(true)
    setTimeout(() => setCopiedPrompt(false), 1500)
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
          <DialogTitle>{t("onboarding.apiTokens.newTokenDialogTitle")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground" role="alert">
            {t("onboarding.apiTokens.showOnceWarning")}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">
              {result.token}
            </code>
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="me-1 size-3.5" />
              {copied ? t("nav.version.copiedLabel") : t("common.copy")}
            </Button>
          </div>
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs" role="alert">
            <p className="flex gap-1.5">
              <ShieldAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
              <span>{t("onboarding.apiTokens.exposureWarning", { mode: result.credential.mode })}</span>
            </p>
            <p className="mt-1.5 ps-5 text-muted-foreground">
              {t("onboarding.apiTokens.exposureConnectHint")}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("onboarding.apiTokens.agentHandoffHint", { mode: result.credential.mode })}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={copyInstructions}>
            <Copy className="me-1 size-3.5" />
            {copiedPrompt ? t("nav.version.copiedLabel") : t("onboarding.apiTokens.copyAgentInstructions")}
          </Button>
          <Button onClick={onClose}>{t("common.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The copy-and-paste prompt a user hands to their agent. Rendered with the real
 * token right after mint (the only moment we hold it) and with a placeholder
 * from the section header, for anyone who already closed that dialog. */
function AgentInstructionsDialog({
  token,
  mode,
  scopeLabel,
  onClose,
}: {
  token?: string
  mode: CredentialMode
  scopeLabel: string
  onClose: () => void
}) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const text = useMemo(
    () => buildAgentInstructions({ syncOrigin: syncWorkerHttpOrigin(), token, mode, scopeLabel }),
    [token, mode, scopeLabel],
  )

  function copy() {
    void navigator.clipboard.writeText(text)
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("onboarding.apiTokens.agentInstructionsDialogTitle")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("onboarding.apiTokens.agentInstructionsBody", { mode })}
            {!token && ` ${t("onboarding.apiTokens.agentInstructionsPlaceholderNote")}`}
          </p>
          <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
            {text}
          </pre>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button onClick={copy}>
            <Copy className="me-1 size-3.5" />
            {copied ? t("nav.version.copiedLabel") : t("onboarding.apiTokens.copyInstructionsButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MintTokenDialog({
  jwt,
  orgs,
  projects,
  disabled,
  onMinted,
}: {
  jwt: string
  orgs: OrgSummary[]
  projects: CloudProjectSummary[]
  disabled: boolean
  onMinted: (result: MintCredentialResult) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [mode, setMode] = useState<CredentialMode>("ask")
  const [orgId, setOrgId] = useState("")
  const [projectId, setProjectId] = useState("")
  const [expiry, setExpiry] = useState<ExpiryPresetId>("90d")
  const [pii, setPii] = useState(false)
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
  // AQU-1180: exposing translator names to an agent is a decision about other
  // people's safety, so it takes an OWNER of the scope — mirrors the server's
  // permission_denied rule rather than letting the user discover it on submit.
  const selectedOrg = orgOptions.find((o) => String(o.id) === orgId) ?? null
  const canPii =
    (selectedProject != null && selectedProject.role.level >= ROLE.OWNER) ||
    (selectedProject == null && selectedOrg != null && selectedOrg.role.level >= ROLE.OWNER)

  useEffect(() => {
    if (open) return
    setName("")
    setMode("ask")
    setOrgId("")
    setProjectId("")
    setExpiry("90d")
    setPii(false)
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

  // Never leave the identity opt-in checked after the scope that authorized it
  // is changed out from under it — the safe state has to be the sticky one.
  useEffect(() => {
    if (!canPii) setPii(false)
  }, [canPii])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    // Drop re-entrant submits (double-click / double Enter) while a mint is in
    // flight, before `busy` has re-rendered the button to disabled.
    if (submittingRef.current) return
    if (!name.trim()) {
      setError(t("onboarding.apiTokens.nameRequired"))
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
        pii: pii || undefined,
      })
      onMinted(result)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("onboarding.apiTokens.mintFailed"))
    } finally {
      submittingRef.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" disabled={disabled} />}>
        {t("onboarding.apiTokens.newTokenTrigger")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("onboarding.apiTokens.newTokenDialogHeading")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="contents">
          <DialogBody className="space-y-4">
            <Field>
              <FieldLabel htmlFor="token-name">{t("common.name")}</FieldLabel>
              <Input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("onboarding.apiTokens.namePlaceholder")}
              />
            </Field>

            <Field>
              <FieldLabel>{t("common.modeLabel")}</FieldLabel>
              <RadioGroup
                value={mode}
                onValueChange={(value) => setMode(value as CredentialMode)}
                className="gap-2"
              >
                <label className="flex items-start gap-2.5 text-sm">
                  <RadioGroupItem value="ask" className="mt-0.5" />
                  <span>
                    <strong>{t("onboarding.apiTokens.modeAskLabel")}</strong> — {t("onboarding.apiTokens.modeAskDescription")}
                  </span>
                </label>
                <label
                  className={`flex items-start gap-2.5 text-sm ${!canAct ? "opacity-50" : ""}`}
                >
                  <RadioGroupItem value="act" className="mt-0.5" disabled={!canAct} />
                  <span>
                    <strong>{t("onboarding.apiTokens.modeActLabel")}</strong> — {t("onboarding.apiTokens.modeActDescription")}
                  </span>
                </label>
              </RadioGroup>
            </Field>

            <Field>
              <FieldLabel htmlFor="token-org">{t("onboarding.apiTokens.orgLabel")}</FieldLabel>
              <Select value={orgId} onValueChange={(value) => setOrgId(value ?? "")}>
                <SelectTrigger id="token-org" className="w-full">
                  <SelectValue placeholder={t("onboarding.apiTokens.orgPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {orgOptions.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>
                        {o.name ?? t("onboarding.apiTokens.scope.orgFallback", { id: o.id })}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {t("onboarding.apiTokens.orgHint")}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="token-project">{t("common.project")}</FieldLabel>
              <Select value={projectId} onValueChange={(value) => setProjectId(value ?? "")}>
                <SelectTrigger id="token-project" className="w-full">
                  <SelectValue placeholder={t("onboarding.apiTokens.projectPlaceholder")} />
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
              <FieldLabel htmlFor="token-expiry">{t("onboarding.apiTokens.expiryLabel")}</FieldLabel>
              <Select
                value={expiry}
                onValueChange={(value) => setExpiry((value ?? "90d") as ExpiryPresetId)}
              >
                <SelectTrigger id="token-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {EXPIRY_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {t(p.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <div className={`flex items-start gap-2.5 text-sm ${!canPii ? "opacity-50" : ""}`}>
                <Checkbox
                  id="token-pii"
                  data-testid="token-pii"
                  checked={pii}
                  onCheckedChange={(checked) => setPii(checked === true)}
                  disabled={!canPii}
                  className="mt-0.5"
                />
                <label htmlFor="token-pii">
                  <strong>{t("onboarding.apiTokens.piiLabel")}</strong>
                  <FieldDescription>
                    {canPii
                      ? t("onboarding.apiTokens.piiDescription")
                      : t("onboarding.apiTokens.piiRequiresOwner")}
                  </FieldDescription>
                </label>
              </div>
            </Field>

            {error && <FieldError role="alert">{error}</FieldError>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {busy ? t("onboarding.apiTokens.mintingButton") : t("onboarding.apiTokens.mintTokenButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
