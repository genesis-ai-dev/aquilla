import { useEffect, useMemo, useRef, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { v4 as uuid } from "uuid"
import { Info, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { Textarea } from "@/components/ui/textarea"
import { LanguageComboboxInput } from "@/components/LanguageComboboxInput"
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
import { cn } from "@/lib/utils"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
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

interface ProjectCreateDialogProps {
  onCreated: (project: ProjectRecord) => void
  /** Scope the new project to a specific org. Omit for personal/default org. */
  orgId?: number
  /** Reuse a parent/provider project directory instead of fetching it again. */
  linkableProjects?: CloudProjectSummary[]
}

/**
 * Two project shapes per AD-9:
 *  - self-contained: owns its source and target (default).
 *  - linked-target:  reads source from another project (shape recorded locally).
 *
 * The source-only shape was retired from creation: a project that exists only
 * to be linked against is now just a self-contained project whose targets go
 * unused. The server still tolerates a blank `targetLanguage` (AD-9), so
 * pre-existing source-only projects keep working — this only removes the
 * affordance for minting new ones.
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
type ProjectShape = "self-contained" | "linked-target"

/**
 * Per-field overrides for this dialog: a touch taller with more horizontal
 * padding so long example placeholders aren't crowded against the edges.
 * Focus chrome comes from the shared Input (border only).
 */
const FIELD_CLASS = "h-9 px-3"

/** Same cap as LanguagesSection's lane registry (settings.targetLanes entries). */
const MAX_EXTRA_LANGUAGE_LENGTH = 64

/**
 * Ceiling on how many lanes one create pass may add. Matches
 * MAX_INVITE_SCOPE_LANES in auth-worker/src/services/invite-scopes.ts so a
 * project can never hold more lanes than a single invite is able to scope
 * somebody to.
 */
const MAX_TARGET_LANES = 50

/**
 * How many individual boxes the target field stacks before it stops growing.
 * Past this the remaining lanes go into one comma-separated field instead:
 * ten rows already make for a tall dialog, and pasting a list beats forty
 * more clicks on the plus button.
 */
const MAX_TARGET_LANE_BOXES = 10

/**
 * AQU-538 creation fix (spec §5): the self-contained shape's target field
 * becomes multi-entry — first/primary stays the project's targetLanguage,
 * the rest land in settings.targetLanes via a follow-up PATCH after create.
 * That PATCH is best-effort: the project itself is already created and
 * should not be rolled back if it fails.
 */
const EXTRA_LANGUAGES_WARNING =
  "Project created; adding extra languages failed — add them in Settings → Languages."

/** How many filled target-language boxes govern create-dialog copy inflection.
 *  Empty extra boxes don't count; an unused form still reads as singular. */
function filledTargetLaneCount(
  targetLanguage: string,
  extraLanguages: readonly string[],
): number {
  const extras = extraLanguages.filter((tag) => tag.trim().length > 0).length
  const primary = targetLanguage.trim() ? 1 : 0
  return Math.max(primary + extras, 1)
}

/** AQU-478: clone vs live — implied by shape (self-contained → clone when
 *  an upstream is chosen; linked-target → live). Kept as a type for the
 *  linkProjectSource call rather than a user-facing radio. */
type LinkMode = "clone" | "live"
/** Which upstream lane becomes this project's source: sibling-language case
 *  ("Its Source") vs chain case ("One of its Targets"). Empty until the user
 *  picks — never prefilled. */
type LinkConsumes = "source" | "target" | ""

const projectSchema = z
  .object({
    name: requiredString("Project title"),
    sourceLanguage: requiredString("Source language"),
    targetLanguage: optionalString,
    // Self-contained shape only (spec §5): extras beyond the primary target,
    // applied as settings.targetLanes after create. Ignored for other shapes.
    extraLanguages: z.array(z.string()),
    shape: z.enum(["self-contained", "linked-target"]),
    upstreamProjectId: optionalString,
    linkConsumes: z.union([z.enum(["source", "target"]), z.literal("")]),
  })
  .superRefine((data, ctx) => {
    if (!data.targetLanguage.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Target language is required",
        path: ["targetLanguage"],
      })
    }
    const upstream = data.upstreamProjectId.trim()
    if (data.shape === "linked-target" && !upstream) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose an upstream project",
        path: ["upstreamProjectId"],
      })
    }
    // Corpus choice is required whenever linking is active: always for
    // linked-target, and for self-contained only once an upstream is picked
    // (empty upstream = plain self-contained create).
    const linking = data.shape === "linked-target" || !!upstream
    if (linking && data.linkConsumes !== "source" && data.linkConsumes !== "target") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose which corpus should become this project's source",
        path: ["linkConsumes"],
      })
    }
  })

export function ProjectCreateDialog({ onCreated, orgId, linkableProjects: suppliedProjects }: ProjectCreateDialogProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const {
    projects: discoveredProjects,
    error: discoveredProjectsError,
  } = useProjectsForNavigation(suppliedProjects == null)
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

  const form = useForm({
    defaultValues: {
      name: "",
      sourceLanguage: "",
      targetLanguage: "",
      extraLanguages: [] as string[],
      shape: "self-contained" as ProjectShape,
      upstreamProjectId: "",
      linkConsumes: "" as LinkConsumes,
    },
    validators: { onSubmit: projectSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      setSubmitWarning(null)

      const jwt = session?.jwt
      if (!jwt) {
        setSubmitError("You need to be signed in to create a project.")
        return
      }

      const project: ProjectRecord = {
        id: draftProjectId.current,
        name: value.name.trim(),
        sourceLanguage: value.sourceLanguage.trim(),
        targetLanguage: value.targetLanguage.trim(),
        createdAt: new Date().toISOString(),
        files: [],
        members: [{ userId: session.username, role: "owner" }],
      }

      let extraLanguagesFailed = false
      const extrasToApply = value.extraLanguages
      const upstreamId = value.upstreamProjectId.trim()
      // Self-contained + upstream → one-time clone; linked-target → live.
      // No upstream on self-contained → plain create, no link call.
      const willLink = !!upstreamId
      const linkMode: LinkMode = value.shape === "linked-target" ? "live" : "clone"
      const linkConsumes = value.linkConsumes === "target" ? "target" : "source"

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

        if (willLink) {
          const linkResult = await linkProjectSource(jwt, project.id, {
            sourceProjectId: upstreamId,
            mode: linkMode,
            consumes: linkConsumes,
          })
          if (linkResult.seeded === false && linkMode === "live") {
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
        setSubmitError(err instanceof Error ? err.message : "Failed to create project. Please try again.")
        return
      }

      await createProject(project)
      posthog.capture("project created", {
        project_id: project.id,
        project_shape: value.shape,
        source_language: project.sourceLanguage,
        target_language: project.targetLanguage,
        extra_target_languages: extrasToApply.length,
        ...(willLink
          ? { link_mode: linkMode, link_consumes: linkConsumes, upstream_project_id: upstreamId }
          : {}),
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
        setSubmitWarning(EXTRA_LANGUAGES_WARNING)
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
    // Shape change clears the corpus answer so a leftover pick from the other
    // shape can't silently satisfy the new path's required choice.
    form.setFieldValue("linkConsumes", "")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        {t("projectSettings.create.trigger")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("projectSettings.create.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <form
          id="project-create-form"
          autoComplete="off"
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
                      <FieldLabel htmlFor="project-create-title">{t("projectSettings.info.titleLabel")}</FieldLabel>
                      <Input
                        id="project-create-title"
                        // Avoid DOM name="name" — Chrome treats it as a contact
                        // field and shows Contact Autofill despite autocomplete=off.
                        name="aquilla-project-title"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
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
                        <FieldLabel htmlFor="project-create-source">{t("projectSettings.info.sourceLanguageLabel")}</FieldLabel>
                        <LanguageFieldHint />
                      </div>
                      <LanguageComboboxInput
                        id="project-create-source"
                        name="aquilla-project-source-language"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        className={FIELD_CLASS}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onValueChange={field.handleChange}
                        placeholder={t("projectSettings.create.sourceLanguagePlaceholder")}
                        aria-invalid={invalid}
                      />
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />

              <form.Field
                name="targetLanguage"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  return (
                    <Field data-invalid={invalid}>
                      <div className="flex items-center gap-1.5">
                        <form.Subscribe
                          selector={(state) =>
                            filledTargetLaneCount(
                              state.values.targetLanguage,
                              state.values.extraLanguages,
                            )
                          }
                        >
                          {(targetLaneCount) => (
                            <FieldLabel htmlFor="project-create-target">
                              {targetLaneCount === 1
                                ? t("projectSettings.info.targetLanguageLabel")
                                : t("projectSettings.create.targetLanguagesLabel")}
                            </FieldLabel>
                          )}
                        </form.Subscribe>
                        <LanguageFieldHint />
                      </div>
                      <form.Field
                        name="extraLanguages"
                        children={(extrasField) => (
                          <TargetLanguageInputs
                            // Remount when the dialog reopens so local row
                            // state can't leak across sessions.
                            key={open ? "open" : "closed"}
                            onPrimaryChange={field.handleChange}
                            onExtrasChange={extrasField.handleChange}
                            onBlur={field.handleBlur}
                            invalid={invalid}
                          />
                        )}
                      />
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />
            </FieldGroup>

            <details className="rounded-xl border px-3 py-2.5 [&[open]>summary]:mb-3">
              <summary className="text-xs font-medium text-muted-foreground select-none">
                {t("projectSettings.create.advancedShapeSummary")}
              </summary>
              <form.Field
                name="shape"
                children={(field) => (
                  <form.Subscribe
                    selector={(state) =>
                      filledTargetLaneCount(
                        state.values.targetLanguage,
                        state.values.extraLanguages,
                      )
                    }
                  >
                    {(targetLaneCount) => (
                      <RadioGroup
                        value={field.state.value}
                        onValueChange={(value) => pickShape(value as ProjectShape)}
                        className="gap-3 pt-1"
                      >
                        <label className="flex items-start gap-2.5 text-sm">
                          <RadioGroupItem
                            value="self-contained"
                            className="mt-0.5"
                            data-testid="create-shape-self-contained"
                          />
                          <span>
                            <RichMessage
                              k="projectSettings.create.shapeSelfContained"
                              count={targetLaneCount}
                              values={{ name: <strong>{t("projectSettings.create.shapeSelfContainedName")}</strong> }}
                            />
                          </span>
                        </label>
                        <label className="flex items-start gap-2.5 text-sm">
                          <RadioGroupItem
                            value="linked-target"
                            className="mt-0.5"
                            data-testid="create-shape-linked-target"
                          />
                          <span>
                            <RichMessage
                              k="projectSettings.create.shapeLinkedTarget"
                              count={targetLaneCount}
                              values={{
                                name: (
                                  <strong>
                                    {t("projectSettings.create.shapeLinkedTargetName", {
                                      count: targetLaneCount,
                                    })}
                                  </strong>
                                ),
                              }}
                            />
                          </span>
                        </label>
                      </RadioGroup>
                    )}
                  </form.Subscribe>
                )}
              />

              <form.Subscribe
                selector={(state) =>
                  [state.values.shape, state.values.upstreamProjectId] as const
                }
                children={([shape, upstreamProjectId]) => {
                  const showCorpusChoice =
                    shape === "linked-target" || !!upstreamProjectId.trim()
                  // Add-as-lane only for the live linked-target sibling case —
                  // a self-contained clone of "Its Source" is a real project,
                  // not a lane recommendation.
                  const showAddAsLane =
                    shape === "linked-target" && !!upstreamProjectId.trim()

                  return (
                    <div className="mt-3 flex flex-col gap-3 border-t pt-3">
                      <p className="text-sm text-muted-foreground">
                        {shape === "linked-target" ? (
                          <RichMessage
                            k="projectSettings.create.liveIntro"
                            values={{
                              mode: <strong>live</strong>,
                            }}
                          />
                        ) : (
                          <RichMessage
                            k="projectSettings.create.cloneIntro"
                            values={{
                              mode: <strong>Cloned</strong>,
                            }}
                          />
                        )}
                      </p>

                      <form.Field
                        name="upstreamProjectId"
                        children={(field) => {
                          const invalid = isFieldInvalid(field)
                          return (
                            <Field data-invalid={invalid}>
                              <FieldLabel htmlFor="upstream-project">{t("projectSettings.create.upstreamProjectLabel")}</FieldLabel>
                              <Select
                                // Base UI SelectValue falls back to the raw
                                // value (a project UUID) unless items maps
                                // each value to its display label — the
                                // dropdown Option text alone is not enough.
                                items={upstreamOptions.map((p) => ({
                                  value: p.id,
                                  label: p.name,
                                }))}
                                value={field.state.value || null}
                                onValueChange={(value) => {
                                  field.handleChange(value ?? "")
                                  // Clearing the upstream on self-contained
                                  // drops the corpus question; reset its answer
                                  // so a stale pick can't satisfy a later link.
                                  if (!value) form.setFieldValue("linkConsumes", "")
                                }}
                              >
                                <SelectTrigger id="upstream-project" aria-invalid={invalid}>
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

                      {showCorpusChoice ? (
                        <form.Field
                          name="linkConsumes"
                          children={(field) => {
                            const invalid = isFieldInvalid(field)
                            return (
                              <Field data-invalid={invalid}>
                                <FieldLabel>{t("projectSettings.create.linkConsumesLabel")}</FieldLabel>
                                <form.Subscribe
                                  selector={(state) =>
                                    filledTargetLaneCount(
                                      state.values.targetLanguage,
                                      state.values.extraLanguages,
                                    )
                                  }
                                >
                                  {(targetLaneCount) => (
                                    <RadioGroup
                                      // null = nothing selected (never prefill).
                                      value={field.state.value || null}
                                      onValueChange={(value) =>
                                        field.handleChange((value ?? "") as LinkConsumes)
                                      }
                                      className="gap-2"
                                    >
                                      <label className="flex items-start gap-2.5 text-sm">
                                        <RadioGroupItem value="source" className="mt-0.5" />
                                        <span>
                                          <RichMessage
                                            k="projectSettings.create.linkConsumesSource"
                                            count={targetLaneCount}
                                            values={{
                                              name: (
                                                <strong>
                                                  {t("projectSettings.create.linkConsumesSourceName")}
                                                </strong>
                                              ),
                                            }}
                                          />
                                        </span>
                                      </label>
                                      <label className="flex items-start gap-2.5 text-sm">
                                        <RadioGroupItem value="target" className="mt-0.5" />
                                        <span>
                                          <RichMessage
                                            k="projectSettings.create.linkConsumesTarget"
                                            values={{
                                              name: (
                                                <strong>
                                                  {t("projectSettings.create.linkConsumesTargetName")}
                                                </strong>
                                              ),
                                            }}
                                          />
                                        </span>
                                      </label>
                                    </RadioGroup>
                                  )}
                                </form.Subscribe>
                                {invalid && <FieldError errors={field.state.meta.errors} />}
                              </Field>
                            )
                          }}
                        />
                      ) : null}

                      {showAddAsLane ? (
                        <form.Subscribe
                          selector={(state) =>
                            [state.values.linkConsumes, state.values.targetLanguage] as const
                          }
                          children={([consumes, targetLanguage]) =>
                            consumes === "source" ? (
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
                      ) : null}
                    </div>
                  )
                }}
              />
            </details>

            {submitError && (
              <FieldError role="alert">
                {submitError}
              </FieldError>
            )}
            {suppliedProjects == null && discoveredProjectsError && (
              <p className="text-sm text-destructive">{discoveredProjectsError}</p>
            )}
            {submitWarning && (
              <p role="status" className="text-xs text-amber-600" data-testid="create-extra-lang-warning">
                {submitWarning}
              </p>
            )}
          </DialogBody>

          <form.Subscribe
            // Track isSubmitting alongside whether this create will link:
            // subscribing to shape alone left the button reading a stale
            // isSubmitting, so it never disabled or showed the spinner during
            // a slow create and each extra click created another project
            // (AQU-711).
            selector={(state) =>
              [
                state.values.shape,
                state.values.upstreamProjectId,
                state.isSubmitting,
              ] as const
            }
            children={([shape, upstreamProjectId, isSubmitting]) => {
              const willLink =
                shape === "linked-target" || !!upstreamProjectId.trim()
              return (
                <Button
                  type="submit"
                  form="project-create-form"
                  disabled={isSubmitting}
                  className="h-9 w-full shrink-0"
                >
                  {isSubmitting && <Spinner data-icon="inline-start" />}
                  {isSubmitting
                    ? (willLink ? "Creating & linking…" : "Creating…")
                    : (willLink ? "Create & Link" : "Create Project")}
                </Button>
              )
            }}
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
  const panelRef = useRef<HTMLDivElement>(null)
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

  // This panel mounts below the fold of DialogBody once "Its source" is
  // chosen (with an upstream already picked). Users are already scrolled to
  // what used to be the bottom, so without this nudge the recommendation is
  // invisible and they have no reason to scroll further.
  useEffect(() => {
    if (!upstreamProject) return
    const node = panelRef.current
    if (!node) return
    const frame = requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: "smooth", block: "nearest" })
    })
    return () => cancelAnimationFrame(frame)
  }, [upstreamProject])

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
      setMessage("You need to be signed in to add a lane.")
      return
    }
    const trimmed = targetLanguage.trim()
    if (!trimmed) {
      setStatus("error")
      setMessage("Enter a target language above first.")
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
        setMessage(`"${trimmed}" is already ${project.name}'s default target language.`)
        return
      }
      if (existingLanes.some((l) => l.toLowerCase() === lower)) {
        setStatus("error")
        setMessage(`"${trimmed}" is already a lane on ${project.name}.`)
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
        setMessage(`Added "${trimmed}" as a lane on ${project.name}. Open that project to start translating.`)
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
        setMessage("Someone else updated that project's settings just now. Try again.")
        return
      }
      if (result.kind === "forbidden") {
        setStatus("error")
        setMessage(`You need maintainer access on ${project.name} to add a lane there.`)
        return
      }
      setStatus("error")
      setMessage("Couldn't add the lane. Please try again.")
    } catch (err) {
      setStatus("error")
      setMessage(err instanceof Error ? err.message : "Couldn't add the lane. Please try again.")
    }
  }

  return (
    <div
      ref={panelRef}
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
      <div className="mt-2.5 flex justify-center">
        <Button
          type="button"
          variant="default"
          className="font-bold"
          data-testid="add-as-lane-btn"
          disabled={!canAttempt || status === "loading"}
          onClick={() => void handleAddAsLane()}
        >
          {status === "loading" && <Spinner data-icon="inline-start" />}
          {status === "loading" ? "Adding lane…" : `Add as lane on ${upstreamProject.name}`}
        </Button>
      </div>
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
 * AQU-538 creation fix (spec §5): the self-contained shape's target field is
 * one text box per lane, stacked, with a plus button that appends another.
 * Box 0 is the project's targetLanguage; the rest become settings.targetLanes
 * via the follow-up PATCH after create.
 *
 * Freeform tags (any label) stay the contract — AQU-988's suggestion list
 * rides on each row through LanguageComboboxInput but never constrains what
 * can be typed.
 */
function validateTargetLanguage(
  candidate: string,
  earlier: string[],
  t: TFunction,
): string | null {
  const trimmed = candidate.trim()
  // A blank row is what an unused box looks like, not an error: the plus
  // button is what gates adding more, and blanks are dropped on submit.
  if (!trimmed) return null
  if (trimmed.length > MAX_EXTRA_LANGUAGE_LENGTH) {
    return t("projectSettings.create.extraLanguagesTooLongError", {
      max: MAX_EXTRA_LANGUAGE_LENGTH,
    })
  }
  const lower = trimmed.toLowerCase()
  if (earlier.some((l) => l.trim().toLowerCase() === lower)) {
    return t("projectSettings.create.extraLanguagesAlreadyAddedError")
  }
  return null
}

/** A target-language box. The id is stable across removals so React never
 *  re-uses one row's DOM (and focus) for another row's value. */
type LaneDraft = { id: number; value: string }

/** Split the overflow field. Commas are the documented separator; newlines
 *  count too so pasting a column of languages works without reformatting. */
function splitBulkLanes(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function TargetLanguageInputs({
  onPrimaryChange,
  onExtrasChange,
  onBlur,
  invalid = false,
}: {
  onPrimaryChange: (next: string) => void
  onExtrasChange: (next: string[]) => void
  onBlur?: () => void
  invalid?: boolean
}) {
  const t = useT()
  // Index 0 is the project's targetLanguage; 1..n are the additional lanes.
  const [lanes, setLanes] = useState<LaneDraft[]>([{ id: 0, value: "" }])
  // Overflow once every box is used: comma-separated, parsed the same way.
  const [bulk, setBulk] = useState("")
  const nextLaneId = useRef(1)

  /**
   * Collapse the boxes and the overflow field into the lane list the form
   * submits. Blank entries, over-long ones, and case-insensitive duplicates
   * are dropped rather than PATCHed; boxes win over the overflow field
   * because they came first. The primary is excluded — it travels as
   * targetLanguage, not as a lane.
   */
  function collectExtras(nextLanes: LaneDraft[], nextBulk: string): string[] {
    const claimed = new Set<string>()
    const primary = (nextLanes[0]?.value ?? "").trim().toLowerCase()
    if (primary) claimed.add(primary)
    const extras: string[] = []
    const candidates = [
      ...nextLanes.slice(1).map((lane) => lane.value),
      ...splitBulkLanes(nextBulk),
    ]
    for (const candidate of candidates) {
      const trimmed = candidate.trim()
      if (!trimmed || trimmed.length > MAX_EXTRA_LANGUAGE_LENGTH) continue
      const lower = trimmed.toLowerCase()
      if (claimed.has(lower)) continue
      // The primary occupies one of the MAX_TARGET_LANES slots.
      if (extras.length >= MAX_TARGET_LANES - 1) break
      claimed.add(lower)
      extras.push(trimmed)
    }
    return extras
  }

  function sync(nextLanes: LaneDraft[], nextBulk: string) {
    setLanes(nextLanes)
    setBulk(nextBulk)
    onPrimaryChange(nextLanes[0]?.value ?? "")
    onExtrasChange(collectExtras(nextLanes, nextBulk))
  }

  const values = lanes.map((l) => l.value)
  const lastFilled = (values[values.length - 1] ?? "").trim().length > 0
  const atBoxLimit = lanes.length >= MAX_TARGET_LANE_BOXES
  const canAddMore = !atBoxLimit && lastFilled
  // What the overflow field contributes beyond the boxes, after dedup and
  // the cap — so the count reflects what would actually be created.
  const bulkAccepted =
    collectExtras(lanes, bulk).length - collectExtras(lanes, "").length

  return (
    <div className="flex flex-col gap-2" data-testid="create-target-lang-inputs">
      <FieldDescription>
        {t("workspace.createDialog.targetChipsHint")}
      </FieldDescription>

      {lanes.map((lane, index) => {
        const error = validateTargetLanguage(lane.value, values.slice(0, index), t)
        return (
          <div key={lane.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <LanguageComboboxInput
                {...(index === 0 ? { id: "project-create-target" } : {})}
                data-testid={
                  index === 0
                    ? "create-extra-lang-input"
                    : `create-target-lang-input-${index}`
                }
                name="aquilla-project-target-language"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className={cn(FIELD_CLASS, "flex-1")}
                value={lane.value}
                exclude={values.filter((_, i) => i !== index)}
                onBlur={index === 0 ? onBlur : undefined}
                onValueChange={(next) =>
                  sync(
                    lanes.map((l, i) => (i === index ? { ...l, value: next } : l)),
                    bulk,
                  )
                }
                placeholder={
                  index === 0
                    ? t("projectSettings.create.targetLanguagePlaceholder")
                    : t("projectSettings.create.additionalTargetPlaceholder")
                }
                aria-invalid={(index === 0 && invalid) || error != null}
              />
              {index > 0 && (
                <button
                  type="button"
                  aria-label={t("projectSettings.create.extraLanguagesRemoveAriaLabel", {
                    lang: lane.value.trim() || String(index + 1),
                  })}
                  data-testid={`create-target-lang-remove-${index}`}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100"
                  onClick={() => sync(lanes.filter((_, i) => i !== index), bulk)}
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              )}
            </div>
            {error && <FieldError className="text-xs">{error}</FieldError>}
          </div>
        )
      })}

      {atBoxLimit ? (
        <div className="flex flex-col gap-1">
          <FieldDescription>
            {t("projectSettings.create.bulkTargetLanguagesHint", {
              max: MAX_TARGET_LANE_BOXES,
            })}
          </FieldDescription>
          <Textarea
            id="project-create-bulk-target-langs"
            data-testid="create-bulk-target-langs"
            name="aquilla-project-bulk-target-languages"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            rows={3}
            value={bulk}
            onChange={(event) => sync(lanes, event.target.value)}
            placeholder={t("projectSettings.create.bulkTargetLanguagesPlaceholder")}
          />
          {bulkAccepted > 0 && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="create-bulk-target-langs-count"
            >
              {t("projectSettings.create.bulkTargetLanguagesCount", {
                count: bulkAccepted,
              })}
            </p>
          )}
        </div>
      ) : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canAddMore}
            data-testid="create-add-target-lang"
            onClick={() =>
              sync([...lanes, { id: nextLaneId.current++, value: "" }], bulk)
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("projectSettings.create.addTargetLanguageAction")}
          </Button>
        </div>
      )}
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
