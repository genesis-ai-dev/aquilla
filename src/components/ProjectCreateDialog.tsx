import { useEffect, useMemo, useRef, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { v4 as uuid } from "uuid"
import { Info, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { createProject } from "@/lib/store/project-index"
import { createCloudProject } from "@/lib/sync/cloud-projects"
import {
  fetchProjectSettings,
  patchProjectSettings,
  PROJECT_SETTINGS_VERSION_INITIAL,
} from "@/lib/sync/project-settings"
import { linkProjectSource, triggerLinkSync } from "@/lib/sync/archive"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectsForNavigation } from "@/hooks/useAccessibleProjects"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString, requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
import { ROLE } from "@/lib/frontier/roles"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import posthog from "@/lib/posthog"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { TFunction } from "@/lib/i18n/I18nProvider"

interface ProjectCreateDialogProps {
  onCreated: (project: ProjectRecord) => void
  /** Scope the new project to a specific org. Omit for personal/default org. */
  orgId?: number
  /** Reuse a parent/provider project directory instead of fetching it again. */
  linkableProjects?: CloudProjectSummary[]
}

/**
 * Three project shapes per AD-9:
 *  - self-contained: owns its source and target (default).
 *  - source-only:    targetLanguage left blank; exists to be linked-against.
 *  - linked-target:  reads source from another project (shape recorded locally).
 *
 * AQU-478: "linked-target" now actually links (previously the shape was
 * recorded locally with no server-side link). See the "linked-target"
 * branch in handleSubmit below for the create → link-with-seed sequence.
 *
 * SWARM-TODO(AQU-478): live-UI walk once AQU-476 is deployed —
 *   1. + New Project → Advanced: project shape → "Linked target".
 *   2. Pick an existing project from the "Upstream project" dropdown.
 *   3. Choose Live (subscribed) vs Clone (one-time snapshot), and — the
 *      "use its source" vs "use its translations" (consumes) choice.
 *   4. Submit → confirm the dialog closes and the new project opens with
 *      the upstream's files/cells ALREADY present (mode='live' seeds via
 *      the first mirror sync inside the auth-worker's /link-source route).
 *   5. Open Project Settings → "Source link" section → confirm it shows
 *      the mode/consumes/gate/cursor badges (not just the upstream id).
 */
type ProjectShape = "self-contained" | "source-only" | "linked-target"

/**
 * Per-field overrides for this dialog: a touch taller with more horizontal
 * padding so long example placeholders aren't crowded against the edges, and a
 * softer focus ring (the global 3px/50% ring read as a halo that obscured the
 * field text). tailwind-merge lets these win over the base Input classes.
 */
const FIELD_CLASS = "h-9 px-3 focus-visible:ring-2 focus-visible:ring-ring/35"

/** Same cap as LanguagesSection's lane registry (settings.targetLanes entries). */
const MAX_EXTRA_LANGUAGE_LENGTH = 64

/** AQU-478: clone vs live — "a checkbox, not a fork" per the design spec §9.2. */
type LinkMode = "clone" | "live"
/** Which upstream lane becomes this project's source: sibling-language case
 *  ("use its source") vs chain case ("use its translations"). */
type LinkConsumes = "source" | "target"

// AQU-832: built inside the component (needs `t()` for the two superRefine
// messages) rather than at module scope. `requiredString()`/`optionalString`
// (src/lib/forms/schemas.ts) are a shared cross-workstream utility whose own
// generated "X is required" messages are NOT localized here — see
// docs/swarm/TRACES.md (SWARM-TODO: zod-validation-messages).
function buildProjectSchema(t: TFunction) {
  return z
    .object({
      name: requiredString("Project name"),
      sourceLanguage: requiredString("Source language"),
      targetLanguage: optionalString,
      // Self-contained shape only (spec §5): extras beyond the primary target,
      // applied as settings.targetLanes after create. Ignored for other shapes.
      extraLanguages: z.array(z.string()),
      shape: z.enum(["self-contained", "source-only", "linked-target"]),
      upstreamProjectId: optionalString,
      linkMode: z.enum(["clone", "live"]),
      linkConsumes: z.enum(["source", "target"]),
    })
    .superRefine((data, ctx) => {
      if (data.shape !== "source-only" && !data.targetLanguage.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("projectSettings.create.validationTargetLanguageRequired"),
          path: ["targetLanguage"],
        })
      }
      if (data.shape === "linked-target" && !data.upstreamProjectId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("projectSettings.create.validationUpstreamProjectRequired"),
          path: ["upstreamProjectId"],
        })
      }
    })
}

export function ProjectCreateDialog({ onCreated, orgId, linkableProjects: suppliedProjects }: ProjectCreateDialogProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const { projects: discoveredProjects } = useProjectsForNavigation(suppliedProjects == null)
  const linkableProjects = suppliedProjects ?? discoveredProjects
  const [open, setOpen] = useState(false)
  // AQU-712: one stable project id per dialog session, minted when the dialog
  // opens and re-minted when it closes (or after a successful create that keeps
  // the dialog open). Reusing the same id across submit attempts within a
  // session — double-click, or an error-then-retry after the server actually
  // committed the row — lets the server's `ON CONFLICT(id) DO NOTHING` dedup
  // land the retry on the same row instead of creating a duplicate project.
  const draftProjectId = useRef(uuid())
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()
  const [submitWarning, setSubmitWarning] = useState<string | null>(null)

  const upstreamOptions = useMemo(
    () => linkableProjects.filter((p) => !p.archivedAt),
    [linkableProjects],
  )
  const projectSchema = useMemo(() => buildProjectSchema(t), [t])

  const form = useForm({
    defaultValues: {
      name: "",
      sourceLanguage: "",
      targetLanguage: "",
      extraLanguages: [] as string[],
      shape: "self-contained" as ProjectShape,
      upstreamProjectId: "",
      linkMode: "live" as LinkMode,
      linkConsumes: "source" as LinkConsumes,
    },
    validators: { onSubmit: projectSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      setSubmitWarning(null)

      const jwt = session?.jwt
      if (!jwt) {
        setSubmitError(t("projectSettings.create.errorSignInRequired"))
        return
      }

      const project: ProjectRecord = {
        id: draftProjectId.current,
        name: value.name.trim(),
        sourceLanguage: value.sourceLanguage.trim(),
        targetLanguage: value.shape === "source-only" ? "" : value.targetLanguage.trim(),
        createdAt: new Date().toISOString(),
        files: [],
        members: [{ userId: session.username, role: "owner" }],
      }

      let extraLanguagesFailed = false
      const extrasToApply = value.shape === "self-contained" ? value.extraLanguages : []

      try {
        await createCloudProject(jwt, { id: project.id, name: project.name, orgId })
        try {
          await patchProjectSettings(jwt, project.id, {
            sourceLanguage: project.sourceLanguage,
            targetLanguage: project.targetLanguage,
          }, 0)
        } catch (err) {
          console.warn("[project-create] settings write failed (non-fatal):", err)
        }

        if (value.shape === "linked-target" && value.upstreamProjectId) {
          const linkResult = await linkProjectSource(jwt, project.id, {
            sourceProjectId: value.upstreamProjectId,
            mode: value.linkMode,
            consumes: value.linkConsumes,
          })
          if (linkResult.seeded === false && value.linkMode === "live") {
            await triggerLinkSync(jwt, project.id)
          }
        }

        if (extrasToApply.length > 0) {
          // Best-effort: fetch the fresh settings version (the row may have
          // just been created above, or the seed write may have failed and
          // left it absent — either way we need the CURRENT version, not a
          // hardcoded 0). A failure here never rolls back the project.
          try {
            const current = await fetchProjectSettings(jwt, project.id)
            const result = await patchProjectSettings(
              jwt,
              project.id,
              { targetLanes: extrasToApply },
              current?.version ?? PROJECT_SETTINGS_VERSION_INITIAL,
            )
            if (result.kind !== "ok") extraLanguagesFailed = true
          } catch (err) {
            console.warn("[project-create] extra languages write failed (non-fatal):", err)
            extraLanguagesFailed = true
          }
        }
      } catch (err) {
        console.error("[project-create] failed:", err)
        setSubmitError(err instanceof Error ? err.message : t("projectSettings.create.errorGeneric"))
        return
      }

      await createProject(project)
      posthog.capture("project created", {
        project_id: project.id,
        project_shape: value.shape,
        source_language: project.sourceLanguage,
        target_language: project.targetLanguage,
        extra_target_languages: extrasToApply.length,
      })
      onCreated(project)
      form.reset()
      clearSubmitError()

      if (extraLanguagesFailed) {
        // The project exists and onCreated already fired — leave the dialog
        // open just long enough for the warning to be readable rather than
        // rolling anything back. This create succeeded, so a subsequent submit
        // in the still-open dialog is a NEW project: mint a fresh draft id so
        // it doesn't false-dedup onto the row we just created (AQU-712).
        draftProjectId.current = uuid()
        setSubmitWarning(t("projectSettings.create.extraLanguagesWarning"))
      } else {
        setOpen(false)
      }
    },
  })

  useEffect(() => {
    if (open) return
    form.reset()
    clearSubmitError()
    setSubmitWarning(null)
    // AQU-712: closing the dialog ends the session — mint a fresh draft id so
    // the next time it opens starts a brand-new project (no false dedup onto a
    // project created in a previous session).
    draftProjectId.current = uuid()
  }, [open, form, clearSubmitError])

  function pickShape(next: ProjectShape) {
    form.setFieldValue("shape", next)
    if (next === "source-only") form.setFieldValue("targetLanguage", "")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus className="size-4" aria-hidden />
        {t("projectSettings.create.trigger")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("projectSettings.create.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <form
          id="project-create-form"
          onSubmit={(e) => {
            e.preventDefault()
            // Guard the Enter-key path too: a disabled submit button already
            // blocks re-entrant clicks, but implicit form submission can still
            // fire while a create is in flight. Bail so one dialog pass creates
            // exactly one project (AQU-711).
            if (form.state.isSubmitting) return
            void form.handleSubmit()
          }}
          className="contents"
        >
          <DialogBody className="flex flex-col gap-5">
            <FieldGroup>
              <form.Field
                name="name"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  return (
                    <Field data-invalid={invalid}>
                      <FieldLabel htmlFor="name">{t("projectSettings.info.nameLabel")}</FieldLabel>
                      <Input
                        id="name"
                        name={field.name}
                        className={FIELD_CLASS}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder={t("projectSettings.create.namePlaceholder")}
                        aria-invalid={invalid}
                      />
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />

              <form.Field
                name="sourceLanguage"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  return (
                    <Field data-invalid={invalid}>
                      <div className="flex items-center gap-1.5">
                        <FieldLabel htmlFor="source">{t("projectSettings.info.sourceLanguageLabel")}</FieldLabel>
                        <LanguageFieldHint />
                      </div>
                      <Input
                        id="source"
                        name={field.name}
                        className={FIELD_CLASS}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder={t("projectSettings.create.sourceLanguagePlaceholder")}
                        aria-invalid={invalid}
                      />
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />

              <form.Subscribe
                selector={(state) => state.values.shape}
                children={(shape) =>
                  shape !== "source-only" ? (
                    <form.Field
                      name="targetLanguage"
                      children={(field) => {
                        const invalid = isFieldInvalid(field)
                        return (
                          <Field data-invalid={invalid}>
                            <div className="flex items-center gap-1.5">
                              <FieldLabel htmlFor="target">
                                {shape === "self-contained"
                                  ? t("projectSettings.create.targetLanguagesLabel")
                                  : t("projectSettings.info.targetLanguageLabel")}
                              </FieldLabel>
                              <LanguageFieldHint />
                            </div>
                            <Input
                              id="target"
                              name={field.name}
                              className={FIELD_CLASS}
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              placeholder={t("projectSettings.create.targetLanguagePlaceholder")}
                              aria-invalid={invalid}
                            />
                            {invalid && <FieldError errors={field.state.meta.errors} />}
                            {shape === "self-contained" && (
                              <form.Field
                                name="extraLanguages"
                                children={(extrasField) => (
                                  <ExtraTargetLanguages
                                    primaryLanguage={field.state.value}
                                    languages={extrasField.state.value}
                                    onChange={extrasField.handleChange}
                                  />
                                )}
                              />
                            )}
                          </Field>
                        )
                      }}
                    />
                  ) : null
                }
              />
            </FieldGroup>

            <details className="rounded-xl border px-3 py-2.5 [&[open]>summary]:mb-3">
              <summary className="text-xs font-medium text-muted-foreground select-none">
                {t("projectSettings.create.advancedShapeSummary")}
              </summary>
              <form.Field
                name="shape"
                children={(field) => (
                  <RadioGroup
                    value={field.state.value}
                    onValueChange={(value) => pickShape(value as ProjectShape)}
                    className="gap-3 pt-1"
                  >
                    <label className="flex items-start gap-2.5 text-sm">
                      <RadioGroupItem value="self-contained" className="mt-0.5" />
                      <span>
                        <RichMessage
                          k="projectSettings.create.shapeSelfContained"
                          values={{ name: <strong>{t("projectSettings.create.shapeSelfContainedName")}</strong> }}
                        />
                      </span>
                    </label>
                    <label className="flex items-start gap-2.5 text-sm">
                      <RadioGroupItem value="source-only" className="mt-0.5" />
                      <span>
                        <RichMessage
                          k="projectSettings.create.shapeSourceOnly"
                          values={{ name: <strong>{t("projectSettings.create.shapeSourceOnlyName")}</strong> }}
                        />
                      </span>
                    </label>
                    <label className="flex items-start gap-2.5 text-sm">
                      <RadioGroupItem value="linked-target" className="mt-0.5" />
                      <span>
                        <RichMessage
                          k="projectSettings.create.shapeLinkedTarget"
                          values={{ name: <strong>{t("projectSettings.create.shapeLinkedTargetName")}</strong> }}
                        />
                      </span>
                    </label>
                  </RadioGroup>
                )}
              />

              <form.Subscribe
                selector={(state) => state.values.shape}
                children={(shape) =>
                  shape === "linked-target" ? (
                    <div className="mt-3 flex flex-col gap-3 border-t pt-3">
                      <form.Field
                        name="upstreamProjectId"
                        children={(field) => {
                          const invalid = isFieldInvalid(field)
                          return (
                            <Field data-invalid={invalid}>
                              <FieldLabel htmlFor="upstream-project">{t("projectSettings.create.upstreamProjectLabel")}</FieldLabel>
                              <Select
                                value={field.state.value}
                                onValueChange={(value) => field.handleChange(value ?? "")}
                              >
                                <SelectTrigger id="upstream-project" className="w-full" aria-invalid={invalid}>
                                  <SelectValue placeholder={t("projectSettings.create.upstreamProjectPlaceholder")} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {upstreamOptions.map((p) => (
                                      <SelectItem key={p.id} value={p.id}>
                                        {p.name}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                              {invalid && <FieldError errors={field.state.meta.errors} />}
                            </Field>
                          )
                        }}
                      />

                      <form.Field
                        name="linkMode"
                        children={(field) => (
                          <Field>
                            <FieldLabel>{t("projectSettings.create.linkModeLabel")}</FieldLabel>
                            <RadioGroup
                              value={field.state.value}
                              onValueChange={(value) => field.handleChange(value as LinkMode)}
                              className="gap-2"
                            >
                              <label className="flex items-start gap-2.5 text-sm">
                                <RadioGroupItem value="live" className="mt-0.5" />
                                <span>
                                  <RichMessage
                                    k="projectSettings.create.linkModeLive"
                                    values={{ name: <strong>{t("projectSettings.sourceLink.modeLive")}</strong> }}
                                  />
                                </span>
                              </label>
                              <label className="flex items-start gap-2.5 text-sm">
                                <RadioGroupItem value="clone" className="mt-0.5" />
                                <span>
                                  <RichMessage
                                    k="projectSettings.create.linkModeClone"
                                    values={{ name: <strong>{t("projectSettings.sourceLink.modeClone")}</strong> }}
                                  />
                                </span>
                              </label>
                            </RadioGroup>
                          </Field>
                        )}
                      />

                      <form.Field
                        name="linkConsumes"
                        children={(field) => (
                          <Field>
                            <FieldLabel>{t("projectSettings.create.linkConsumesLabel")}</FieldLabel>
                            <RadioGroup
                              value={field.state.value}
                              onValueChange={(value) => field.handleChange(value as LinkConsumes)}
                              className="gap-2"
                            >
                              <label className="flex items-start gap-2.5 text-sm">
                                <RadioGroupItem value="source" className="mt-0.5" />
                                <span>
                                  <RichMessage
                                    k="projectSettings.create.linkConsumesSource"
                                    values={{ name: <strong>{t("projectSettings.create.linkConsumesSourceName")}</strong> }}
                                  />
                                </span>
                              </label>
                              <label className="flex items-start gap-2.5 text-sm">
                                <RadioGroupItem value="target" className="mt-0.5" />
                                <span>
                                  <RichMessage
                                    k="projectSettings.create.linkConsumesTarget"
                                    values={{ name: <strong>{t("projectSettings.create.linkConsumesTargetName")}</strong> }}
                                  />
                                </span>
                              </label>
                            </RadioGroup>
                          </Field>
                        )}
                      />

                      <form.Subscribe
                        selector={(state) =>
                          [
                            state.values.linkConsumes,
                            state.values.upstreamProjectId,
                            state.values.targetLanguage,
                          ] as const
                        }
                        children={([consumes, upstreamProjectId, targetLanguage]) =>
                          consumes === "source" && upstreamProjectId ? (
                            <AddAsLaneRecommendation
                              jwt={session?.jwt}
                              upstreamProject={
                                upstreamOptions.find((p) => p.id === upstreamProjectId) ?? null
                              }
                              targetLanguage={targetLanguage}
                              onAdded={() => {
                                form.reset()
                                clearSubmitError()
                                setOpen(false)
                              }}
                            />
                          ) : null
                        }
                      />
                    </div>
                  ) : null
                }
              />
            </details>

            {submitError && (
              <FieldError role="alert">
                {submitError}
              </FieldError>
            )}
            {submitWarning && (
              <p role="status" className="text-xs text-amber-600" data-testid="create-extra-lang-warning">
                {submitWarning}
              </p>
            )}
          </DialogBody>

          <form.Subscribe
            // Track isSubmitting alongside shape: subscribing to shape alone
            // left the button reading a stale isSubmitting, so it never
            // disabled or showed the spinner during a slow create and each
            // extra click created another project (AQU-711).
            selector={(state) => [state.values.shape, state.isSubmitting] as const}
            children={([shape, isSubmitting]) => (
              <Button
                type="submit"
                form="project-create-form"
                disabled={isSubmitting}
                className="h-9 w-full shrink-0"
              >
                {isSubmitting && <Spinner data-icon="inline-start" />}
                {isSubmitting
                  ? (shape === "linked-target"
                      ? t("projectSettings.create.submitCreatingAndLinking")
                      : t("projectSettings.create.submitCreating"))
                  : (shape === "linked-target"
                      ? t("projectSettings.create.submitCreateAndLink")
                      : t("projectSettings.create.submitCreate"))}
              </Button>
            )}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * AQU-538 slice 3: the sibling-language ("linked-target" + consumes="source")
 * case is demoted by the TMS lane model — a new sibling target language off a
 * shared source should be a lane on the upstream project, not a second
 * project kept in sync by the mirror engine. This panel steers that flow
 * without removing it (the classic linked-project path stays available for
 * the chain/consumes="target" case).
 *
 * Save flow mirrors ProjectSettings/LanguagesSection.tsx's "add a lane":
 * fetchProjectSettings for the current version + existing lanes, a
 * case-insensitive duplicate/default-lane check, then patchProjectSettings
 * with ifMatchVersion. Unlike LanguagesSection this targets the UPSTREAM
 * project (not the project being created), and on success no project is
 * created at all — the dialog just closes.
 */
function AddAsLaneRecommendation({
  jwt,
  upstreamProject,
  targetLanguage,
  onAdded,
}: {
  jwt: string | undefined
  upstreamProject: CloudProjectSummary | null
  targetLanguage: string
  onAdded: () => void
}) {
  const t = useT()
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [message, setMessage] = useState<string | null>(null)
  // Auto-close is deferred so the success hint is actually perceivable
  // before the dialog disappears (an immediate onAdded() would batch with
  // the success setState and never paint the message).
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    },
    [],
  )

  if (!upstreamProject) return null

  // Role data is only reliably present on some project-list endpoints (see
  // CloudProjectSummary comments). When it's missing we show the button
  // unconditionally per AQU-538 slice 3 and let the settings PATCH's 403
  // surface as a friendly "forbidden" message instead of pre-guessing.
  const roleLevel = upstreamProject.role?.level
  const roleKnown = roleLevel != null
  const canAttempt = !roleKnown || roleLevel >= ROLE.MAINTAINER

  async function handleAddAsLane() {
    const project = upstreamProject
    if (!project) return
    if (!jwt) {
      setStatus("error")
      setMessage(t("projectSettings.create.laneRecommendationSignInError"))
      return
    }
    const trimmed = targetLanguage.trim()
    if (!trimmed) {
      setStatus("error")
      setMessage(t("projectSettings.create.laneRecommendationEmptyTargetError"))
      return
    }

    setStatus("loading")
    setMessage(null)
    try {
      const current = await fetchProjectSettings(jwt, project.id)
      const existingLanes = current?.settings.targetLanes ?? []
      const defaultLane = (current?.settings.targetLanguage ?? "").trim()
      const lower = trimmed.toLowerCase()
      if (lower === defaultLane.toLowerCase()) {
        setStatus("error")
        setMessage(t("projectSettings.create.laneRecommendationAlreadyDefaultError", { lane: trimmed, projectName: project.name }))
        return
      }
      if (existingLanes.some((l) => l.toLowerCase() === lower)) {
        setStatus("error")
        setMessage(t("projectSettings.create.laneRecommendationAlreadyLaneError", { lane: trimmed, projectName: project.name }))
        return
      }

      const result = await patchProjectSettings(
        jwt,
        project.id,
        { targetLanes: [...existingLanes, trimmed] },
        current?.version ?? 0,
      )
      if (result.kind === "ok") {
        setStatus("success")
        setMessage(t("projectSettings.create.laneRecommendationSuccess", { lane: trimmed, projectName: project.name }))
        posthog.capture("sibling lane added from create dialog", {
          upstream_project_id: project.id,
          lane: trimmed,
        })
        // Give the success hint a beat on screen, then close — no project
        // was created, so there's nothing else for this dialog to do.
        closeTimerRef.current = setTimeout(onAdded, 900)
        return
      }
      if (result.kind === "conflict") {
        setStatus("error")
        setMessage(t("projectSettings.create.laneRecommendationConflictError"))
        return
      }
      if (result.kind === "forbidden") {
        setStatus("error")
        setMessage(t("projectSettings.create.laneRecommendationForbiddenError", { projectName: project.name }))
        return
      }
      setStatus("error")
      setMessage(t("projectSettings.create.laneRecommendationGenericError"))
    } catch (err) {
      setStatus("error")
      setMessage(err instanceof Error ? err.message : t("projectSettings.create.laneRecommendationGenericError"))
    }
  }

  return (
    <div
      className="rounded-xl border border-primary/30 bg-primary/5 p-3"
      data-testid="add-as-lane-panel"
    >
      <p className="text-sm">
        <RichMessage
          k="projectSettings.create.laneRecommendation"
          values={{
            heading: <strong>{t("projectSettings.create.laneRecommendationHeading")}</strong>,
            projectName: <strong>{upstreamProject.name}</strong>,
          }}
        />
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-2.5"
        data-testid="add-as-lane-btn"
        disabled={!canAttempt || status === "loading"}
        onClick={() => void handleAddAsLane()}
      >
        {status === "loading" && <Spinner data-icon="inline-start" />}
        {status === "loading"
          ? t("projectSettings.create.laneRecommendationAdding")
          : t("projectSettings.create.laneRecommendationAddButton", { projectName: upstreamProject.name })}
      </Button>
      {message && status === "error" && (
        <FieldError className="mt-2 text-xs">{message}</FieldError>
      )}
      {message && status !== "error" && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  )
}

/**
 * AQU-538 creation fix (spec §5): a lightweight tag list for extra target
 * languages on the self-contained shape. The primary target-language input
 * stays put above this — that value remains the project's required
 * targetLanguage; entries added here become settings.targetLanes after
 * create. Validation mirrors ProjectSettings/LanguagesSection.tsx's "add a
 * lane" (trim, <=64 chars, case-insensitive dedupe — including against the
 * primary language, which isn't itself a lane).
 */
function validateExtraLanguageDraft(
  candidate: string,
  primaryLanguage: string,
  languages: string[],
  t: TFunction,
): string | null {
  const trimmed = candidate.trim()
  if (!trimmed) return t("projectSettings.create.extraLanguagesEmptyError")
  if (trimmed.length > MAX_EXTRA_LANGUAGE_LENGTH) {
    return t("projectSettings.create.extraLanguagesTooLongError", { max: MAX_EXTRA_LANGUAGE_LENGTH })
  }
  const lower = trimmed.toLowerCase()
  if (lower === primaryLanguage.trim().toLowerCase()) {
    return t("projectSettings.create.extraLanguagesDuplicatePrimaryError")
  }
  if (languages.some((l) => l.toLowerCase() === lower)) {
    return t("projectSettings.create.extraLanguagesAlreadyAddedError")
  }
  return null
}

function ExtraTargetLanguages({
  primaryLanguage,
  languages,
  onChange,
}: {
  primaryLanguage: string
  languages: string[]
  onChange: (next: string[]) => void
}) {
  const t = useT()
  const [input, setInput] = useState("")
  const [error, setError] = useState<string | null>(null)

  function handleAdd() {
    const validationError = validateExtraLanguageDraft(input, primaryLanguage, languages, t)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    onChange([...languages, input.trim()])
    setInput("")
  }

  const invalid = error != null

  return (
    <div className="mt-2 flex flex-col gap-2">
      <FieldDescription>
        {t("projectSettings.create.extraLanguagesDescription")}
      </FieldDescription>
      {languages.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {languages.map((lang) => (
            <li
              key={lang}
              data-testid={`create-extra-lang-chip-${lang}`}
            >
              <Badge variant="secondary" className="gap-1">
                {lang}
                <button
                  type="button"
                  aria-label={t("projectSettings.create.extraLanguagesRemoveAriaLabel", { lang })}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => onChange(languages.filter((l) => l !== lang))}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Field data-invalid={invalid}>
        <div className="flex items-center gap-2">
          <Input
            data-testid="create-extra-lang-input"
            className={`${FIELD_CLASS} flex-1`}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                handleAdd()
              }
            }}
            placeholder={t("projectSettings.create.extraLanguagesPlaceholder")}
            aria-invalid={invalid}
          />
          <Button type="button" variant="secondary" size="sm" data-testid="create-extra-lang-add" onClick={handleAdd}>
            <Plus className="me-1 h-3.5 w-3.5" />
            {t("common.add")}
          </Button>
        </div>
        {error && <FieldError className="text-xs">{error}</FieldError>}
      </Field>
    </div>
  )
}

function LanguageFieldHint() {
  const t = useT()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("projectSettings.create.languageHintAriaLabel")}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {t("projectSettings.create.languageHintTooltip")}
      </TooltipContent>
    </Tooltip>
  )
}
