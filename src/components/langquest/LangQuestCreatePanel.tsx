import { useAccountAnalytics } from "@/hooks/useAccountAnalytics"
// The LangQuest branch of the New-project wizard (AQU-2105), one choice per
// step, rendered from the wizard state the dialog owns (lib/langquest/wizard.ts):
//
//   org      — which connected LangQuest organization (or connect another)
//   connect  — open LangQuest Connect in a new tab, paste the token once; it is
//              stored with the account (never shown again) and the org appears
//              in the list from now on
//   language — which of the org's languages to follow
//   details  — destination, name → Create makes the project, adds a target
//              lane in the LangQuest language, and links it FROM THE CONNECTION
//              (no token leaves the browser). If the link fails, the panel stays
//              open with the reason and Create retries just the link (AQU-2126).
//
// The import itself is the link's first sync, which the project's LangQuest
// badge starts as soon as the project opens.

import { useEffect, useState, type Dispatch } from "react"
import { Check, ExternalLink, Minus, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DialogBody, DialogFooter } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Spinner } from "@/components/ui/spinner"
import { ProjectDestinationPicker, type Destination } from "@/components/ProjectDestinationPicker"
import { ProjectTeamsPicker, teamsRequired } from "@/components/ProjectTeamsPicker"
import { LangQuestLogo } from "@/components/langquest/LangQuestLogo"
import { LangQuestHealthBadge } from "@/components/langquest/LangQuestHealthBadge"
import { OptionButton, StepHeading } from "@/components/wizard/OptionButton"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { createCloudProject } from "@/lib/sync/cloud-projects"
import { createProjectLane, fetchProjectSettings, renameProjectLane } from "@/lib/sync/project-settings"
import { createProject } from "@/lib/store/project-index"
import {
  connectLangQuest,
  fetchLangQuestConnectionLanguages,
  LangQuestLinkError,
  linkLangQuestFromConnection,
} from "@/lib/langquest/api"
import { accessLevel, canLinkLanguage, capabilityRows } from "@/lib/langquest/permissions"
import type { LangQuestConnection, LangQuestLanguage } from "@/lib/langquest/types"
import { connectUrlFor, isUsable, type WizardAction, type WizardState } from "@/lib/langquest/wizard"
import type { ProjectRecord } from "@/lib/parsers/types"

/** Passage labels come from LangQuest's (English) templates. */
const LABEL_LANGUAGE = "en"

const TOKEN_RE = /^lqp_[A-Za-z0-9_-]{16,}$/

export interface LangQuestCreatePanelProps {
  jwt: string | undefined
  username: string | undefined
  /** The dialog's draft project id, read at create time (AQU-712 retry dedupe). */
  getProjectId: () => string
  pageOrgId?: number
  state: WizardState
  dispatch: Dispatch<WizardAction>
  onCreated: (project: ProjectRecord) => void
}

export function LangQuestCreatePanel(props: LangQuestCreatePanelProps) {
  const { state, dispatch } = props
  const { t } = useI18n()
  // Languages per connection, filled by connecting or by asking; a reconnect
  // through `connected` replaces the entry.
  const [languages, setLanguages] = useState<Record<string, LangQuestLanguage[]>>({})
  const remember = (connectionId: string, list: LangQuestLanguage[]) =>
    setLanguages((prev) => ({ ...prev, [connectionId]: list }))

  switch (state.step.kind) {
    case "loading":
      return (
        <DialogBody>
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy data-testid="langquest-loading-step">
            <Spinner /> {t("langquest.wizard.connectionsLoading")}
          </p>
        </DialogBody>
      )
    case "org":
      return <OrgStep {...props} />
    case "connect":
      return <ConnectStep {...props} onLanguages={remember} />
    case "language":
      return (
        <LanguageStep
          {...props}
          connectionId={state.step.connectionId}
          known={languages[state.step.connectionId]}
          onLanguages={remember}
        />
      )
    case "details": {
      const { connectionId, languageId } = state.step
      const connection = state.connections.find((c) => c.id === connectionId)
      const language = languages[connectionId]?.find((l) => l.languageId === languageId)
      if (!connection || !language) {
        // The dialog never renders details without both; a reload of the panel
        // alone (dev HMR) could. Step back rather than show a broken form.
        dispatch({ type: "back" })
        return null
      }
      return <DetailsStep {...props} connection={connection} language={language} />
    }
    default:
      return null
  }
}

// ── org ────────────────────────────────────────────────────────────────────

function OrgStep({ state, dispatch }: LangQuestCreatePanelProps) {
  const { t } = useI18n()
  return (
    <>
      <DialogBody>
        <div className="flex flex-col gap-4" data-testid="langquest-org-step">
          <StepHeading title={t("langquest.wizard.orgTitle")} hint={t("langquest.wizard.orgHint")} />
          <div className="flex flex-col gap-2">
            {state.connections.map((c) => (
              <OptionButton
                key={c.id}
                icon={<LangQuestLogo className="size-5" />}
                title={c.org.name}
                hint={
                  isUsable(c)
                    ? t("langquest.wizard.linkedProjects", { count: c.linkedProjects })
                    : t("langquest.wizard.needsReconnect")
                }
                trailing={<LangQuestHealthBadge health={c.health} />}
                onClick={() =>
                  isUsable(c) ? dispatch({ type: "pickConnection", connectionId: c.id }) : dispatch({ type: "startConnect" })
                }
                data-testid={`langquest-org-${c.org.id}`}
              />
            ))}
            <OptionButton
              icon={<Plus />}
              title={t("langquest.wizard.connectAnother")}
              onClick={() => dispatch({ type: "startConnect" })}
              data-testid="langquest-connect-another"
            />
          </div>
        </div>
      </DialogBody>
    </>
  )
}

// ── connect ────────────────────────────────────────────────────────────────

function ConnectStep({
  jwt,
  state,
  dispatch,
  onLanguages,
}: LangQuestCreatePanelProps & { onLanguages: (connectionId: string, list: LangQuestLanguage[]) => void }) {
  const analytics = useAccountAnalytics()
  const { t } = useI18n()
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connectUrl = connectUrlFor(state.connections)

  const connect = async () => {
    const trimmed = token.trim()
    if (!TOKEN_RE.test(trimmed)) {
      setError(t("langquest.error.notToken"))
      return
    }
    if (!jwt) return
    setBusy(true)
    setError(null)
    try {
      const { connection, languages } = await connectLangQuest(jwt, trimmed)
      onLanguages(connection.id, languages)
      analytics.capture("langquest org connected", {
        scopes: connection.token.scopes,
        language_count: languages.length,
        all_languages: connection.token.allLanguages,
        reconnect: state.connections.some((c) => c.id === connection.id),
      })
      setToken("")
      dispatch({ type: "connected", connection })
    } catch (err) {
      setError(failureText(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogBody>
        <fieldset disabled={busy} aria-busy={busy} className="flex min-w-0 flex-col gap-5" data-testid="langquest-connect-step">
          <StepHeading title={t("langquest.wizard.connectTitle")} hint={t("langquest.wizard.connectIntro")} />
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full justify-center gap-2"
            // The whole point of the step: tokens are made over there.
            render={<a href={connectUrl} target="_blank" rel="noreferrer" data-testid="langquest-open-connect" />}
          >
            <LangQuestLogo className="size-4" />
            {t("langquest.create.openConnect")}
            <ExternalLink className="size-3.5" aria-hidden />
          </Button>
          <FieldGroup>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="langquest-token">{t("langquest.create.tokenLabel")}</FieldLabel>
              <RevealableInput
                id="langquest-token"
                autoComplete="off"
                spellCheck={false}
                // i18n-exempt: LangQuest token prefix, not copy
                placeholder="lqp_…"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value)
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void connect()
                  }
                }}
              />
              <FieldDescription>{t("langquest.create.tokenHelp")}</FieldDescription>
              {error && <FieldError>{error}</FieldError>}
            </Field>
          </FieldGroup>
        </fieldset>
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          className="h-9 w-full"
          onClick={() => void connect()}
          disabled={!token.trim() || busy || !jwt}
          data-testid="langquest-connect-submit"
        >
          {busy ? <Spinner data-icon="inline-start" /> : <LangQuestLogo />}
          {busy ? t("langquest.wizard.connecting") : t("langquest.wizard.connect")}
        </Button>
      </DialogFooter>
    </>
  )
}

// ── language ───────────────────────────────────────────────────────────────

function LanguageStep({
  jwt,
  state,
  dispatch,
  connectionId,
  known,
  onLanguages,
}: LangQuestCreatePanelProps & {
  connectionId: string
  known: LangQuestLanguage[] | undefined
  onLanguages: (connectionId: string, list: LangQuestLanguage[]) => void
}) {
  const { t } = useI18n()
  const connection = state.connections.find((c) => c.id === connectionId)
  const [error, setError] = useState<{ text: string; needsReauth: boolean } | null>(null)
  const loading = known == null && error == null

  // Ask LangQuest only when the connect step did not just tell us. This is
  // also the connection's health probe: a 401 here is what marks it broken.
  useEffect(() => {
    if (known != null || !jwt) return
    let cancelled = false
    fetchLangQuestConnectionLanguages(jwt, connectionId)
      .then(({ connection: fresh, languages }) => {
        if (cancelled) return
        onLanguages(connectionId, languages)
        dispatch({ type: "connectionsLoaded", connections: state.connections.map((c) => (c.id === fresh.id ? fresh : c)) })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const needsReauth = err instanceof LangQuestLinkError && (err.needsReauth || err.status === 401 || err.status === 409)
        setError({ text: failureText(t, err), needsReauth })
      })
    return () => {
      cancelled = true
    }
    // state.connections is read for the merge only; re-running on it would re-probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, connectionId, known])

  return (
    <DialogBody>
      <div className="flex flex-col gap-4" data-testid="langquest-language-step" aria-busy={loading}>
        <StepHeading title={t("langquest.wizard.languageTitle")} hint={t("langquest.wizard.languageHint")} />
        {connection && (
          <p className="text-sm text-muted-foreground" data-testid="langquest-token-org">
            {t("langquest.create.tokenFor", { org: connection.org.name })}
          </p>
        )}
        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t("langquest.wizard.languageLoading", { org: connection?.org.name ?? "LangQuest" })}
          </p>
        )}
        {error && (
          <div className="flex flex-col gap-2">
            <FieldError>{error.text}</FieldError>
            {error.needsReauth && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  // Back to the org fork, then straight into pasting a new token.
                  dispatch({ type: "back" })
                  dispatch({ type: "startConnect" })
                }}
              >
                {t("langquest.wizard.reconnect")}
              </Button>
            )}
          </div>
        )}
        {known && (
          <div className="flex flex-col gap-2">
            {known.map((l) => {
              const ok = canLinkLanguage(l.can)
              return (
                <OptionButton
                  key={l.languageId}
                  title={ok ? l.name : t("langquest.create.noAccess", { name: l.name })}
                  hint={ok ? t(`langquest.access.${accessLevel(l.can)}`) : undefined}
                  disabled={!ok}
                  onClick={() => dispatch({ type: "pickLanguage", languageId: l.languageId })}
                  data-testid={`langquest-language-${l.languageId}`}
                />
              )
            })}
          </div>
        )}
      </div>
    </DialogBody>
  )
}

// ── details ────────────────────────────────────────────────────────────────

function DetailsStep({
  jwt,
  username,
  getProjectId,
  pageOrgId,
  connection,
  language,
  onCreated,
}: LangQuestCreatePanelProps & { connection: LangQuestConnection; language: LangQuestLanguage }) {
  const analytics = useAccountAnalytics()
  const { t } = useI18n()
  const [name, setName] = useState(language.name)
  const [destination, setDestination] = useState<Destination | null>(null)
  const [teamIds, setTeamIds] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // AQU-2126: set once the cloud project and its lanes exist. If the link then
  // fails, the dialog stays open and Create retries only the link, so a retry
  // never adds a second target lane and the name stays as created.
  const [prepared, setPrepared] = useState<string | null>(null)

  const needTeams = teamsRequired(destination?.role, destination?.orgId)
  const canCreate = !!jwt && !!name.trim() && !!destination && (!needTeams || teamIds.length > 0)

  const create = async () => {
    if (!canCreate || !jwt || !destination) return
    setBusy(true)
    setError(null)
    const project: ProjectRecord = {
      id: getProjectId(),
      name: name.trim(),
      sourceLanguage: LABEL_LANGUAGE,
      targetLanguage: language.code,
      createdAt: new Date().toISOString(),
      files: [],
      members: [{ userId: username ?? "", role: "owner" }],
    }
    if (prepared !== project.id) {
      try {
        await createCloudProject(jwt, {
          id: project.id,
          name: project.name,
          orgId: destination.orgId,
          teamIds: destination.orgId != null ? teamIds : undefined,
        })
      } catch (err) {
        console.error("[langquest-create] project create failed:", err)
        setError(t("langquest.error.createFailed"))
        setBusy(false)
        return
      }
      // Lanes: the passage labels are the source; the recordings perform the
      // LangQuest language, so it is the target lane the takes land in.
      try {
        const settings = await fetchProjectSettings(jwt, project.id)
        const sourceLane = settings?.lanes?.find((lane) => lane.role === "source")
        if (sourceLane) await renameProjectLane(jwt, project.id, sourceLane.id, { language: LABEL_LANGUAGE })
        await createProjectLane(jwt, project.id, { name: language.name, language: language.code })
      } catch (err) {
        console.warn("[langquest-create] lane write failed (non-fatal):", err)
      }
      setPrepared(project.id)
    }
    try {
      await linkLangQuestFromConnection(jwt, project.id, connection.id, language.languageId)
    } catch (err) {
      // The project exists but nothing else in the app can link it (the
      // badge only shows on linked projects), so keep the dialog open here.
      console.error("[langquest-create] link failed:", err)
      analytics.capture("langquest link failed", {
        project_id: project.id,
        status: err instanceof LangQuestLinkError ? err.status : null,
      })
      setError(t("langquest.error.linkFailed", { reason: failureText(t, err) }))
      setBusy(false)
      return
    }
    await createProject(project)
    analytics.capture("project created", {
      project_id: project.id,
      project_shape: "langquest",
      source_language: project.sourceLanguage,
      target_language: project.targetLanguage,
      langquest_linked: true,
      langquest_scopes: connection.token.scopes,
      langquest_access: accessLevel(language.can),
      langquest_from_connection: true,
    })
    setBusy(false)
    onCreated(project)
  }

  return (
    <>
      <DialogBody>
        <fieldset disabled={busy} aria-busy={busy} className="flex min-w-0 flex-col gap-5" data-testid="langquest-details-step">
          <StepHeading
            title={t("langquest.wizard.detailsTitle")}
            hint={t("langquest.panel.orgLanguage", { language: language.name, org: connection.org.name })}
          />
          <ProjectDestinationPicker jwt={jwt} pageOrgId={pageOrgId} onChange={setDestination} disabled={busy || prepared !== null} />
          {destination?.orgId != null && (
            <ProjectTeamsPicker
              teams={destination.teams ?? []}
              required={needTeams}
              value={teamIds}
              onValueChange={setTeamIds}
              showRequiredError={false}
              disabled={busy || prepared !== null}
            />
          )}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="langquest-project-name">{t("langquest.create.nameLabel")}</FieldLabel>
              <Input id="langquest-project-name" value={name} onChange={(e) => setName(e.target.value)} disabled={prepared !== null} />
            </Field>
            <PermissionList can={language.can} />
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </fieldset>
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          className="h-9 w-full"
          onClick={() => void create()}
          disabled={!canCreate || busy}
          data-testid="langquest-create-submit"
        >
          {busy ? <Spinner data-icon="inline-start" /> : <LangQuestLogo />}
          {busy ? t("langquest.create.creating") : prepared ? t("langquest.create.retryLink") : t("langquest.create.submit")}
        </Button>
      </DialogFooter>
    </>
  )
}

function failureText(t: ReturnType<typeof useI18n>["t"], err: unknown): string {
  if (err instanceof LangQuestLinkError) {
    if (err.needsReauth || err.status === 401) return t("langquest.error.tokenRejected")
  }
  return t("langquest.error.unreachable")
}

/** Every capability the link could use, ticked or not, with the scope that grants it. */
export function PermissionList({ can }: { can: Parameters<typeof capabilityRows>[0] }) {
  const { t } = useI18n()
  const level = accessLevel(can)
  return (
    <section className="rounded-lg border p-3" data-testid="langquest-permissions" aria-labelledby="langquest-permissions-title">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id="langquest-permissions-title" className="text-sm font-medium">
          {t("langquest.create.permissionsTitle")}
        </h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {t(`langquest.access.${level}`)}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {capabilityRows(can).map((row) => (
          <li key={row.capability} className="flex items-start gap-2 text-sm" data-granted={row.granted}>
            {row.granted ? (
              <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className={row.granted ? undefined : "text-muted-foreground"}>
              {t(`langquest.capability.${row.capability}`)}
              {!row.usedByAquilla && <span className="block text-xs text-muted-foreground">{t("langquest.capability.notUsed")}</span>}
              {row.usedByAquilla && !row.granted && (
                <span className="block text-xs text-muted-foreground">
                  {t("langquest.capability.missing", { scope: row.scope })}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
