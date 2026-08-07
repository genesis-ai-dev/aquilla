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
import { cn } from "@/lib/utils"
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
 * padding so long example placeholders aren't crowded against the edges.
 * Focus chrome comes from the shared Input (border only).
 */
const FIELD_CLASS = "h-9 px-3"

/** Same cap as LanguagesSection's lane registry (settings.targetLanes entries). */
const MAX_EXTRA_LANGUAGE_LENGTH = 64

/**
 * AQU-538 creation fix (spec §5): the self-contained shape's target field
 * becomes multi-entry — first/primary stays the project's targetLanguage,
 * the rest land in settings.targetLanes via a follow-up PATCH after create.
 * That PATCH is best-effort: the project itself is already created and
 * should not be rolled back if it fails.
 */
const EXTRA_LANGUAGES_WARNING =
  "Project created; adding extra languages failed — add them in Settings → Languages."

/** AQU-478: clone vs live — "a checkbox, not a fork" per the design spec §9.2. */
type LinkMode = "clone" | "live"
/** Which upstream lane becomes this project's source: sibling-language case
 *  ("use its source") vs chain case ("use its translations"). */
type LinkConsumes = "source" | "target"

const projectSchema = z
  .object({
    name: requiredString("Project title"),
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
        message: "Target language is required",
        path: ["targetLanguage"],
      })
    }
    if (data.shape === "linked-target" && !data.upstreamProjectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose an upstream project",
        path: ["upstreamProjectId"],
      })
    }
  })

export function ProjectCreateDialog({ onCreated, orgId, linkableProjects: suppliedProjects }: ProjectCreateDialogProps) {
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
        setSubmitError("You need to be signed in to create a project.")
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
    if (next === "source-only") form.setFieldValue("targetLanguage", "")
    if (next !== "self-contained") form.setFieldValue("extraLanguages", [])
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus className="size-4" aria-hidden />
        New Project
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
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
                      <FieldLabel htmlFor="project-create-title">Project title</FieldLabel>
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
                        placeholder="My Translation Project"
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
                        <FieldLabel htmlFor="project-create-source">Source language</FieldLabel>
                        <LanguageFieldHint />
                      </div>
                      <Input
                        id="project-create-source"
                        name="aquilla-project-source-language"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        className={FIELD_CLASS}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder="English, Grade 7 English, es-419…"
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
                              <FieldLabel htmlFor="project-create-target">
                                {shape === "self-contained" ? "Target language(s)" : "Target language"}
                              </FieldLabel>
                              <LanguageFieldHint />
                            </div>
                            {shape === "self-contained" ? (
                              <form.Field
                                name="extraLanguages"
                                children={(extrasField) => (
                                  <TargetLanguageChips
                                    // Remount when the dialog reopens so local
                                    // chip/draft state can't leak across sessions.
                                    key={open ? "open" : "closed"}
                                    onPrimaryChange={field.handleChange}
                                    onExtrasChange={extrasField.handleChange}
                                    onBlur={field.handleBlur}
                                    invalid={invalid}
                                  />
                                )}
                              />
                            ) : (
                              <Input
                                id="project-create-target"
                                name="aquilla-project-target-language"
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                className={FIELD_CLASS}
                                value={field.state.value}
                                onBlur={field.handleBlur}
                                onChange={(e) => field.handleChange(e.target.value)}
                                placeholder="French, conversational Swahili, zh-Hant…"
                                aria-invalid={invalid}
                              />
                            )}
                            {invalid && <FieldError errors={field.state.meta.errors} />}
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
                Advanced: project shape
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
                        <strong>Self-contained</strong> — owns its source and target.
                      </span>
                    </label>
                    <label className="flex items-start gap-2.5 text-sm">
                      <RadioGroupItem value="source-only" className="mt-0.5" />
                      <span>
                        <strong>Source-only</strong> — a canonical source others link
                        against. No target.
                      </span>
                    </label>
                    <label className="flex items-start gap-2.5 text-sm">
                      <RadioGroupItem value="linked-target" className="mt-0.5" />
                      <span>
                        <strong>Linked target</strong> — reads source from another
                        project; owns only its target.
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
                              <FieldLabel htmlFor="upstream-project">Upstream project</FieldLabel>
                              <Select
                                value={field.state.value}
                                onValueChange={(value) => field.handleChange(value ?? "")}
                              >
                                <SelectTrigger id="upstream-project" aria-invalid={invalid}>
                                  <SelectValue placeholder="Choose a project to link from…" />
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
                            <FieldLabel>Clone or live?</FieldLabel>
                            <RadioGroup
                              value={field.state.value}
                              onValueChange={(value) => field.handleChange(value as LinkMode)}
                              className="gap-2"
                            >
                              <label className="flex items-start gap-2.5 text-sm">
                                <RadioGroupItem value="live" className="mt-0.5" />
                                <span>
                                  <strong>Live</strong> — stays subscribed; upstream fixes
                                  propagate here automatically.
                                </span>
                              </label>
                              <label className="flex items-start gap-2.5 text-sm">
                                <RadioGroupItem value="clone" className="mt-0.5" />
                                <span>
                                  <strong>Clone</strong> — one-time snapshot; this project
                                  becomes independent immediately.
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
                            <FieldLabel>What should become this project&apos;s source?</FieldLabel>
                            <RadioGroup
                              value={field.state.value}
                              onValueChange={(value) => field.handleChange(value as LinkConsumes)}
                              className="gap-2"
                            >
                              <label className="flex items-start gap-2.5 text-sm">
                                <RadioGroupItem value="source" className="mt-0.5" />
                                <span>
                                  <strong>Its source</strong> — sibling-translation case
                                  (this project translates the same original text).
                                  For same-org sibling languages, a target lane on the
                                  upstream project is the recommended shape instead.
                                </span>
                              </label>
                              <label className="flex items-start gap-2.5 text-sm">
                                <RadioGroupItem value="target" className="mt-0.5" />
                                <span>
                                  <strong>Its translations</strong> — chain case (this
                                  project translates the upstream project&apos;s target,
                                  e.g. French → Chaluba).
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
                  ? (shape === "linked-target" ? "Creating & linking…" : "Creating…")
                  : (shape === "linked-target" ? "Create & Link" : "Create Project")}
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
      className="rounded-xl border border-primary/30 bg-primary/5 p-3"
      data-testid="add-as-lane-panel"
    >
      <p className="text-sm">
        <strong>Same source, new language?</strong> Add it as a target lane on{" "}
        <strong>{upstreamProject.name}</strong> instead — no separate project to keep in
        sync.
      </p>
      <Button
        type="button"
        variant="secondary"
        className="mt-2.5"
        data-testid="add-as-lane-btn"
        disabled={!canAttempt || status === "loading"}
        onClick={() => void handleAddAsLane()}
      >
        {status === "loading" && <Spinner data-icon="inline-start" />}
        {status === "loading" ? "Adding lane…" : `Add as lane on ${upstreamProject.name}`}
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
 * AQU-538 creation fix (spec §5): one chips field for all target languages on
 * the self-contained shape. Type → Enter commits a pill; the first pill is
 * the project's targetLanguage and the rest become settings.targetLanes after
 * create. An uncommitted draft still counts as the primary (so create works
 * without Enter).
 *
 * Freeform tags (any label) — not a Combobox suggestion list. Combobox's
 * controlled inputValue/value dance clears the draft on Enter and raced our
 * commit, so chips never stuck in the real browser. This field keeps the
 * ComboboxChips look with plain state instead.
 */
function validateTargetLanguageDraft(
  candidate: string,
  languages: string[],
): string | null {
  const trimmed = candidate.trim()
  if (!trimmed) return "Enter a language tag."
  if (trimmed.length > MAX_EXTRA_LANGUAGE_LENGTH) {
    return `Must be ${MAX_EXTRA_LANGUAGE_LENGTH} characters or fewer.`
  }
  const lower = trimmed.toLowerCase()
  if (languages.some((l) => l.toLowerCase() === lower)) {
    return "Already added."
  }
  return null
}

function TargetLanguageChips({
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
  const [chips, setChips] = useState<string[]>([])
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function syncForm(nextChips: string[], nextDraft: string) {
    onPrimaryChange(nextChips[0] ?? nextDraft)
    onExtrasChange(nextChips.slice(1))
  }

  function commitDraft() {
    const validationError = validateTargetLanguageDraft(draft, chips)
    if (validationError) {
      setError(validationError)
      return
    }
    const nextChips = [...chips, draft.trim()]
    setChips(nextChips)
    setDraft("")
    setError(null)
    syncForm(nextChips, "")
  }

  function removeChip(lang: string) {
    const nextChips = chips.filter((l) => l !== lang)
    setChips(nextChips)
    setError(null)
    syncForm(nextChips, draft)
  }

  const chipInvalid = invalid || error != null

  return (
    <div className="flex flex-col gap-2">
      <FieldDescription>
        Type a language and press Enter to add it. The first is the primary
        target; extras become additional lanes.
      </FieldDescription>
      <div
        data-testid="create-target-lang-chips"
        className={cn(
          // Match ComboboxChips field chrome so this reads as one input.
          "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent bg-clip-padding px-3 py-1.5 text-sm transition-colors",
          "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          "has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20",
          "dark:bg-input/30 dark:has-aria-invalid:border-destructive/50 dark:has-aria-invalid:ring-destructive/40",
          chips.length > 0 && "px-1.5",
        )}
        onMouseDown={(event) => {
          // Clicking the field chrome focuses the input without stealing
          // clicks from chip remove buttons.
          if (event.target !== inputRef.current) {
            const remove = (event.target as HTMLElement).closest("button")
            if (remove) return
            event.preventDefault()
            inputRef.current?.focus()
          }
        }}
      >
        {chips.map((lang) => (
          <Badge
            key={lang}
            variant="secondary"
            data-testid={`create-extra-lang-chip-${lang}`}
            // Match ComboboxChip: muted surface + tighter radius so the pill
            // separates from dark:bg-input/30 field chrome.
            className="h-[calc(--spacing(5.25))] gap-1 rounded-sm bg-muted px-1.5 pr-0 text-xs font-medium text-foreground"
          >
            {lang}
            <button
              type="button"
              aria-label={`Remove ${lang}`}
              className="-ml-0.5 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-50 hover:opacity-100"
              onClick={() => removeChip(lang)}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </Badge>
        ))}
        <input
          ref={inputRef}
          id="project-create-target"
          data-testid="create-extra-lang-input"
          name="aquilla-project-target-language"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="min-w-16 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          value={draft}
          placeholder={
            chips.length === 0
              ? "French, conversational Swahili, zh-Hant…"
              : "Add another…"
          }
          aria-invalid={chipInvalid}
          onBlur={onBlur}
          onChange={(event) => {
            const next = event.target.value
            setDraft(next)
            setError(null)
            syncForm(chips, next)
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && draft === "" && chips.length > 0) {
              event.preventDefault()
              removeChip(chips[chips.length - 1]!)
              return
            }
            if (event.key !== "Enter") return
            // Always intercept Enter so the dialog form doesn't submit while
            // committing (or rejecting) a chip.
            event.preventDefault()
            event.stopPropagation()
            commitDraft()
          }}
        />
      </div>
      {error && <FieldError className="text-xs">{error}</FieldError>}
    </div>
  )
}

function LanguageFieldHint() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="What can I enter here?"
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Any label works — a BCP-47 tag, a language name, or a register
        description (e.g. "Grade 7 English", "conversational Swahili").
      </TooltipContent>
    </Tooltip>
  )
}
