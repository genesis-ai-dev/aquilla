// The "Import from LangQuest" path of the New project dialog (AQU-2105).
//
// Paste a token from LangQuest's /connect page → Aquilla asks LangQuest what
// it reaches (POST /inspect, nothing stored) → the panel says what the token
// lets Aquilla do for the chosen language → Create makes the project, adds a
// target lane in the LangQuest language, and links it (the token is stored
// encrypted on the server from here on). The import itself is the link's
// first sync, which the project's LangQuest badge starts as soon as the
// project opens — so a long import never holds this dialog open.

import { useState } from "react"
import { Check, ExternalLink, Minus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DialogBody, DialogFooter } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { ProjectDestinationPicker, type Destination } from "@/components/ProjectDestinationPicker"
import { ProjectTeamsPicker, teamsRequired } from "@/components/ProjectTeamsPicker"
import { LangQuestLogo } from "@/components/langquest/LangQuestLogo"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatDate } from "@/lib/i18n/format"
import { createCloudProject } from "@/lib/sync/cloud-projects"
import { createProjectLane, fetchProjectSettings, renameProjectLane } from "@/lib/sync/project-settings"
import { createProject } from "@/lib/store/project-index"
import { inspectLangQuestToken, LangQuestLinkError, linkLangQuest } from "@/lib/langquest/api"
import { accessLevel, canLinkLanguage, capabilityRows } from "@/lib/langquest/permissions"
import type { LangQuestInspection } from "@/lib/langquest/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import posthog from "@/lib/posthog"

/** Where tokens are made. The preview API base points at the preview app. */
function connectUrl(apiBase: string | undefined): string {
  try {
    if (apiBase) return `${new URL(apiBase).origin}/connect`
  } catch {
    // fall through to production
  }
  return "https://next.langquest.org/connect"
}

/** Passage labels come from LangQuest's (English) templates. */
const LABEL_LANGUAGE = "en"

const TOKEN_RE = /^lqp_[A-Za-z0-9_-]{16,}$/

export interface LangQuestCreatePanelProps {
  jwt: string | undefined
  username: string | undefined
  /** The dialog's draft project id, read at create time (AQU-712 retry dedupe). */
  getProjectId: () => string
  pageOrgId?: number
  onBack: () => void
  onCreated: (project: ProjectRecord) => void
}

export function LangQuestCreatePanel({ jwt, username, getProjectId, pageOrgId, onBack, onCreated }: LangQuestCreatePanelProps) {
  const { t, locale } = useI18n()
  const [token, setToken] = useState("")
  const [inspection, setInspection] = useState<LangQuestInspection | null>(null)
  const [languageId, setLanguageId] = useState<string>("")
  const [name, setName] = useState("")
  const [destination, setDestination] = useState<Destination | null>(null)
  const [teamIds, setTeamIds] = useState<number[]>([])
  const [busy, setBusy] = useState<"checking" | "creating" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const language = inspection?.languages.find((l) => l.languageId === languageId) ?? null
  const needTeams = teamsRequired(destination?.role, destination?.orgId)
  const canCreate =
    !!jwt && !!language && canLinkLanguage(language.can) && !!name.trim() && !!destination && (!needTeams || teamIds.length > 0)

  const failureText = (err: unknown): string => {
    if (err instanceof LangQuestLinkError) {
      if (err.needsReauth || err.status === 401) return t("langquest.error.tokenRejected")
      if (err.status === 502) return t("langquest.error.unreachable")
    }
    return t("langquest.error.unreachable")
  }

  const check = async () => {
    const trimmed = token.trim()
    if (!TOKEN_RE.test(trimmed)) {
      setError(t("langquest.error.notToken"))
      return
    }
    if (!jwt) return
    setBusy("checking")
    setError(null)
    try {
      const result = await inspectLangQuestToken(jwt, trimmed)
      setInspection(result)
      const first = result.languages.find((l) => canLinkLanguage(l.can))
      setLanguageId(first?.languageId ?? "")
      if (first && !name.trim()) setName(first.name)
      posthog.capture("langquest token checked", {
        scopes: result.token.scopes,
        language_count: result.languages.length,
        all_languages: result.token.allLanguages,
      })
    } catch (err) {
      setInspection(null)
      setError(failureText(err))
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    if (!canCreate || !jwt || !language || !destination || !inspection) return
    setBusy("creating")
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
      setBusy(null)
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
    let linked = true
    try {
      await linkLangQuest(jwt, project.id, token.trim(), language.languageId)
    } catch (err) {
      console.error("[langquest-create] link failed:", err)
      linked = false
    }
    await createProject(project)
    posthog.capture("project created", {
      project_id: project.id,
      project_shape: "langquest",
      source_language: project.sourceLanguage,
      target_language: project.targetLanguage,
      langquest_linked: linked,
      langquest_scopes: inspection.token.scopes,
      langquest_access: accessLevel(language.can),
    })
    setBusy(null)
    // The project exists either way, so creation completes; the badge in the
    // project offers the link again.
    if (!linked) toast.add({ type: "warning", title: t("langquest.error.linkFailed") })
    onCreated(project)
  }

  return (
    <>
      <DialogBody>
        <fieldset disabled={busy !== null} aria-busy={busy !== null} className="flex min-w-0 flex-col gap-5">
          <ProjectDestinationPicker jwt={jwt} pageOrgId={pageOrgId} onChange={setDestination} disabled={busy !== null} />
          {destination?.orgId != null && (
            <ProjectTeamsPicker
              teams={destination.teams ?? []}
              required={needTeams}
              value={teamIds}
              onValueChange={setTeamIds}
              showRequiredError={false}
              disabled={busy !== null}
            />
          )}
          <FieldGroup>
            <Field data-invalid={!!error && !inspection}>
              <FieldLabel htmlFor="langquest-token">{t("langquest.create.tokenLabel")}</FieldLabel>
              <div className="flex gap-2">
                <RevealableInput
                  id="langquest-token"
                  autoComplete="off"
                  spellCheck={false}
                  // i18n-exempt: LangQuest token prefix, not copy
                  placeholder="lqp_…"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value)
                    setInspection(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void check()
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={() => void check()} disabled={!token.trim()}>
                  {busy === "checking" ? <Spinner aria-label={t("langquest.create.checking")} /> : t("langquest.create.check")}
                </Button>
              </div>
              <FieldDescription>
                {t("langquest.create.tokenHelp")}{" "}
                <a
                  href={connectUrl(inspection?.apiBase)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  {t("langquest.create.openConnect")}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </FieldDescription>
            </Field>

            {inspection && (
              <>
                <p className="text-sm text-muted-foreground" data-testid="langquest-token-org">
                  {t("langquest.create.tokenFor", { org: inspection.org.name })} ·{" "}
                  {inspection.token.expiresAt
                    ? t("common.expiresOn", { date: formatDate(new Date(inspection.token.expiresAt), locale, {}) })
                    : t("langquest.create.neverExpires")}
                </p>
                <Field>
                  <FieldLabel htmlFor="langquest-language">{t("langquest.create.languageLabel")}</FieldLabel>
                  <Select
                    items={inspection.languages.map((l) => ({ value: l.languageId, label: l.name }))}
                    value={languageId}
                    onValueChange={(value) => {
                      if (!value) return
                      setLanguageId(value)
                      const picked = inspection.languages.find((l) => l.languageId === value)
                      if (picked) setName(picked.name)
                    }}
                  >
                    <SelectTrigger id="langquest-language" data-testid="langquest-language">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {inspection.languages.map((l) => (
                          <SelectItem key={l.languageId} value={l.languageId} disabled={!canLinkLanguage(l.can)}>
                            {canLinkLanguage(l.can) ? l.name : t("langquest.create.noAccess", { name: l.name })}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                {language && <PermissionList can={language.can} />}
                <Field>
                  <FieldLabel htmlFor="langquest-project-name">{t("langquest.create.nameLabel")}</FieldLabel>
                  <Input id="langquest-project-name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              </>
            )}
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
        </fieldset>
      </DialogBody>
      <DialogFooter className="flex-row gap-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy !== null}>
          {t("common.back")}
        </Button>
        <Button
          type="button"
          className="h-9 flex-1"
          onClick={() => void create()}
          disabled={!canCreate || busy !== null}
          data-testid="langquest-create-submit"
        >
          {busy === "creating" ? <Spinner data-icon="inline-start" /> : <LangQuestLogo />}
          {busy === "creating" ? t("langquest.create.creating") : t("langquest.create.submit")}
        </Button>
      </DialogFooter>
    </>
  )
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
