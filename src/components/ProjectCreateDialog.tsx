import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useForm, useStore } from "@tanstack/react-form"
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
import { ProjectCombobox } from "@/components/ProjectCombobox"
import { UpstreamFileChoiceList } from "@/components/UpstreamFileChoiceList"
import { UpstreamLaneChoiceField } from "@/components/UpstreamLaneChoiceField"
import { useUpstreamLaneChoices } from "@/hooks/useUpstreamLaneChoices"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
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
import { ProjectDestinationPicker, type Destination } from "@/components/ProjectDestinationPicker"
import { ProjectTeamsPicker, teamsRequired } from "@/components/ProjectTeamsPicker"
import {
  createProjectLane,
  fetchProjectSettings,
  renameProjectLane,
} from "@/lib/sync/project-settings"
import { laneLanguage } from "@/lib/lanes/lane-display"
import { isPrimaryRegistryLane } from "@/lib/lanes/registry-lanes"
import { linkProjectSource, triggerLinkSync } from "@/lib/sync/archive"
import { INHERIT_DEFAULTS } from "@/lib/sync/inherited-settings"
import { InheritedSettingsChoice } from "@/components/ProjectSettings/InheritedSettingsChoice"
import { markLinkSeedFailed } from "@/lib/sync/link-seed-status"
import { summarizeFileSelection } from "@/lib/sync/link-file-selection"
import {
  loadUpstreamFileChoices,
  type LinkSourcePreviewFile,
} from "@/lib/sync/link-source-preview"
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
 *   2. Pick an existing project from the searchable "Upstream project"
 *      picker (type to filter, or scroll the full list).
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
 * AQU-1240 slice 1: the self-contained shape's target field is multi-entry —
 * first/primary stays the project's targetLanguage AND is the first entry in
 * settings.targetLanes (the complete lane registry), followed by extras.
 * That write is best-effort: the project itself is already created and
 * should not be rolled back if it fails.
 */
const EXTRA_LANGUAGES_WARNING =
  "Project created; adding extra languages failed — add them in Settings → Languages."

/**
 * AQU-1519: how long the dialog waits before admitting a create is overrunning
 * and handing the user a way out. Deliberately generous — a linked-target
 * create seeds the whole upstream inside the same request, so linking a full
 * Bible legitimately takes a while and must not trip this. The request is
 * never cancelled; this only decides when the dialog stops being a dead end.
 */
const LONG_RUNNING_WORK_MS = 120_000

const LONG_RUNNING_WORK_MESSAGE =
  "This is taking longer than expected. You can close this dialog — the project " +
  "may still finish and show up in your projects list."

/**
 * AQU-1519: what the dialog is busy doing. Anything non-null locks every
 * control in the body AND every way of closing, so a stray click mid-create
 * can no longer edit the form under a request in flight or — on the
 * linked-target path — add a lane to the upstream while its clone is still
 * being built.
 */
type DialogWork = "creating" | "adding-lane"

/**
 * Complete lane registry for the create settings PATCH: primary first, then
 * extras, case-insensitively deduped (trim + lower, matching collectExtras).
 * Always includes the primary — `settings.targetLanes` is the full registry.
 */
function completeTargetLanes(primary: string, extras: readonly string[]): string[] {
  const claimed = new Set<string>()
  const lanes: string[] = []
  for (const raw of [primary, ...extras]) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (claimed.has(key)) continue
    claimed.add(key)
    lanes.push(trimmed)
  }
  return lanes
}

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
    // Self-contained shape only (spec §5 / AQU-1240): extras beyond the
    // primary; the PATCH writes targetLanes as [primary, ...extras].
    extraLanguages: z.array(z.string()),
    shape: z.enum(["self-contained", "linked-target"]),
    upstreamProjectId: optionalString,
    linkConsumes: z.union([z.enum(["source", "target"]), z.literal("")]),
    // AQU-1605: which of the upstream's lanes a chain link consumes (`lanes.id`).
    // Empty for the sibling case, which consumes the upstream's one source lane.
    upstreamLaneId: optionalString,
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
    // AQU-1605: the chain case has to name the translation it consumes. Without
    // it the server falls back to whichever of the upstream's lanes carries the
    // empty legacy tag, which is an accident of history rather than a choice.
    if (linking && data.linkConsumes === "target" && !data.upstreamLaneId.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose which of the upstream project's translations to use",
        path: ["upstreamLaneId"],
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
  const [work, setWork] = useState<DialogWork | null>(null)
  const [workOverran, setWorkOverran] = useState(false)
  const locked = work !== null
  // The escape hatch: once the work has overrun, closing is allowed again so
  // the dialog can never trap the user. The fields stay locked either way —
  // the request is still in flight and editing it would change nothing.
  const canClose = !locked || workOverran

  /** Release the lock and the overrun notice together — they only ever move as
   *  one, and keeping them in step here is what lets the overrun timer below be
   *  a pure subscription with no setState in its body. */
  function releaseWork() {
    setWork(null)
    setWorkOverran(false)
  }

  // AQU-1352: null until create-targets loads (and again on every reload,
  // close, or page-org change). Submit is disabled while it is null, so a
  // stale or unresolved choice can never pick the org (review finding).
  const [destination, setDestination] = useState<Destination | null>(null)
  // AQU-1352 P2: teams to create into; reset whenever the destination changes.
  const [teamIds, setTeamIds] = useState<number[]>([])
  const [teamsError, setTeamsError] = useState(false)
  const needTeams = teamsRequired(destination?.role, destination?.orgId)
  const onDestination = (next: Destination | null) => {
    setDestination(next)
    setTeamIds([])
    setTeamsError(false)
  }

  const upstreamOptions = useMemo(
    () => linkableProjects.filter((p) => !p.archivedAt),
    [linkableProjects],
  )

  // ── AQU-1561: which of the chosen upstream's files this create brings in ──
  //
  // Null until the list lands (and again whenever the upstream changes), which
  // is what tells the "loading" sentence from the empty-upstream one: an
  // upstream with no files is `[]`, and that still creates. `filesFailed` is the
  // third state — the read failed, so the dialog cannot say what would be
  // brought in and refuses to guess; `filesAttempt` is bumped by "Try again" so
  // the effect re-runs for the same upstream.
  const [upstreamFiles, setUpstreamFiles] = useState<LinkSourcePreviewFile[] | null>(null)
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [filesFailed, setFilesFailed] = useState(false)
  const [filesAttempt, setFilesAttempt] = useState(0)
  const [inheritReceive, setInheritReceive] = useState({ ...INHERIT_DEFAULTS })
  const [inheritDetached, setInheritDetached] = useState<Partial<Record<keyof typeof INHERIT_DEFAULTS, boolean>>>({})
  const inheritReceiveRef = useRef(inheritReceive)
  inheritReceiveRef.current = inheritReceive
  const fileChoices = useMemo(() => upstreamFiles ?? [], [upstreamFiles])
  const { selectedCount, allSelected, nothingSelected } = useMemo(
    () => summarizeFileSelection(fileChoices, selectedFileIds),
    [fileChoices, selectedFileIds],
  )

  const toggleFile = useCallback((fileId: string) => {
    setSelectedFileIds((current) => {
      const next = new Set(current)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }, [])

  const form = useForm({
    defaultValues: {
      name: "",
      sourceLanguage: "",
      targetLanguage: "",
      extraLanguages: [] as string[],
      shape: "self-contained" as ProjectShape,
      upstreamProjectId: "",
      upstreamLaneId: "",
      linkConsumes: "" as LinkConsumes,
    },
    validators: { onSubmit: projectSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()

      // AQU-1519: the dialog locks for the whole create and unlocks in the
      // `finally`, so no early return (sign-in, a failed call) can leave it
      // stuck. A validation failure never reaches here — the form rejects it
      // first — so this can never lock a user out of fixing a bad field.
      setWork("creating")
      try {
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

        if (!destination) return
        if (needTeams && teamIds.length === 0) {
          setTeamsError(true)
          setSubmitError(t("projectSettings.create.teamsRequiredError"))
          return
        }

        let extraLanguagesFailed = false
        const extrasToApply = value.extraLanguages
        const upstreamId = value.upstreamProjectId.trim()
        // Self-contained + upstream → one-time clone; linked-target → live.
        // No upstream on self-contained → plain create, no link call.
        const willLink = !!upstreamId
        const linkMode: LinkMode = value.shape === "linked-target" ? "live" : "clone"
        const linkConsumes = value.linkConsumes === "target" ? "target" : "source"
        // AQU-1605: only the chain case carries a lane — the sibling case
        // consumes the upstream's source lane, which the server records itself.
        const linkLaneId = linkConsumes === "target" ? value.upstreamLaneId.trim() : ""
        // AQU-1561: guarded as well as disabled — nothing may create a project
        // whose link follows no files, or one whose file list was never read.
        // Nothing has been created at this point, so returning is clean.
        if (willLink && (nothingSelected || filesFailed)) {
          setSubmitError(
            filesFailed
              ? t("projectSettings.create.upstreamFilesLoadError")
              : t("projectSettings.create.upstreamFilesNoneSelected"),
          )
          return
        }
        // Every file checked means "bring in all of it": the request omits the
        // list entirely, so a live link follows the whole upstream (including
        // files it gains later) exactly as before this slice, and a clone copies
        // everything. A subset sends the picked upstream file ids, which pins a
        // live link to them and narrows a clone's one snapshot to them.
        const pickedFileIds =
          allSelected || fileChoices.length === 0 ? undefined : [...selectedFileIds]

        try {
          await createCloudProject(jwt, {
            id: project.id,
            name: project.name,
            orgId: destination.orgId,
            teamIds: destination.orgId != null ? teamIds : undefined,
          })

          // AQU-1594: languages are lane rows, not project-level settings keys.
          // The create already inserted a source lane. Name it, then add each
          // requested target lane. The first target's legacy tag is its language.
          try {
            const current = await fetchProjectSettings(jwt, project.id)
            const sourceLane = current?.lanes?.find((lane) => lane.role === "source")
            if (!sourceLane) {
              extraLanguagesFailed = true
            } else if (project.sourceLanguage) {
              const renamed = await renameProjectLane(jwt, project.id, sourceLane.id, {
                language: project.sourceLanguage,
              })
              if (renamed.kind !== "ok") extraLanguagesFailed = true
            }
            for (const language of completeTargetLanes(project.targetLanguage, extrasToApply)) {
              const created = await createProjectLane(jwt, project.id, { name: "", language })
              if (created.kind !== "ok") {
                extraLanguagesFailed = true
                break
              }
            }
          } catch (err) {
            console.warn("[project-create] lane write failed (non-fatal):", err)
            extraLanguagesFailed = true
          }

          if (willLink) {
            const linkResult = await linkProjectSource(jwt, project.id, {
              sourceProjectId: upstreamId,
              mode: linkMode,
              consumes: linkConsumes,
              ...(linkLaneId ? { laneId: linkLaneId } : {}),
              ...(pickedFileIds ? { fileIds: pickedFileIds } : {}),
              inherit: inheritReceiveRef.current,
            })
            if (linkResult.seeded === false && linkMode === "live") {
              // AQU-1544: the retry's answer used to be dropped, so a failed
              // first sync opened an empty project with nothing said. The
              // project exists and is linked either way, so creation still
              // completes and the dialog still closes (AQU-1519) — the failure
              // is parked for the project page the user lands on, which shows
              // it with a "Try again" (LinkSeedFailedBanner).
              const synced = await triggerLinkSync(jwt, project.id)
              if (!synced) markLinkSeedFailed(project.id)
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
            ? {
                link_mode: linkMode,
                link_consumes: linkConsumes,
                upstream_project_id: upstreamId,
                // AQU-1561: whether this create took the whole upstream or a
                // pick of it, and how big the pick was.
                link_file_scope: pickedFileIds ? "subset" : "all",
                link_file_count: pickedFileIds ? pickedFileIds.length : fileChoices.length,
              }
            : {}),
        })
        onCreated(project)
        toast.add({
          type: "success",
          title: t("projectSettings.create.createdToast", {
            name: project.name,
            destination:
              destination.orgId == null
                ? t("projectSettings.create.destinationPersonal")
                : destination.name,
          }),
        })
        form.reset()
        clearSubmitError()

        // AQU-1519: a successful create ALWAYS closes the dialog, partial
        // success included. A failed lanes PATCH is a warning about a project
        // that exists, not a reason to hold the user in a form they are done
        // with — so it rides a toast on the page they land on, where it survives
        // the close instead of being wiped by it.
        if (extraLanguagesFailed) {
          toast.add({ type: "warning", title: EXTRA_LANGUAGES_WARNING })
        }
        setOpen(false)
      } finally {
        releaseWork()
      }
    },
  })

  // AQU-1561: the upstream whose files are on offer. Read off the form rather
  // than mirrored in state, so clearing the picker, switching shape and
  // `form.reset()` on close all reach this one place.
  const chosenUpstreamId = useStore(form.store, (state) =>
    state.values.upstreamProjectId.trim(),
  )

  // ── AQU-1605: which of the chosen upstream's lanes this link consumes ──
  //
  // Read off the form for the same reason the file list is: the corpus answer
  // moves with the shape, the picker and `form.reset()`, and this must follow it
  // rather than keep a copy that can disagree. Only the chain case asks — a link
  // that consumes the upstream's SOURCE has one lane to read.
  const chosenConsumes = useStore(form.store, (state) => state.values.linkConsumes)
  const laneChoices = useUpstreamLaneChoices(
    session?.jwt,
    chosenUpstreamId,
    chosenConsumes === "target",
  )
  const laneOptions = laneChoices.lanes
  useEffect(() => {
    if (!laneOptions) return
    // One lane is pre-filled, never asked (AQU-1419: no forced chooser at one
    // lane) — it is still named on screen, so the choice stays visible.
    if (laneOptions.length === 1) {
      form.setFieldValue("upstreamLaneId", laneOptions[0]!.id)
      return
    }
    // A pick the list no longer holds (another upstream, or lanes this user's
    // grants have since narrowed) must not survive into the request.
    const current = form.getFieldValue("upstreamLaneId")
    if (current && !laneOptions.some((lane) => lane.id === current)) {
      form.setFieldValue("upstreamLaneId", "")
    }
  }, [laneOptions, form])

  useEffect(() => {
    // No upstream, no question to ask — and the stale answer must go with it, so
    // a cleared picker cannot leave a previous upstream's files armed.
    if (!open || !chosenUpstreamId || !session?.jwt) {
      setUpstreamFiles(null)
      setSelectedFileIds(new Set())
      setFilesFailed(false)
      return
    }
    let cancelled = false
    // Dropped before the read, not after it: the list belongs to the upstream
    // being loaded, and the dialog must not show the previous one's files
    // checked while this one is in flight.
    setUpstreamFiles(null)
    setSelectedFileIds(new Set())
    setFilesFailed(false)
    void loadUpstreamFileChoices(session.jwt, chosenUpstreamId)
      .then((files) => {
        if (cancelled) return
        setUpstreamFiles(files)
        // Everything checked, every time the upstream changes — "bring in all of
        // it" is the behaviour this dialog had before the slice, so it stays the
        // default, and a fresh upstream never inherits the last one's picks.
        setSelectedFileIds(new Set(files.map((f) => f.id)))
      })
      .catch(() => {
        if (!cancelled) setFilesFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, chosenUpstreamId, session?.jwt, filesAttempt])

  // AQU-1561: the two states that make a create-with-upstream impossible —
  // nothing checked (a project that brings in no files is a mistake, not a
  // choice) and a file list that could not be read (the dialog would be
  // guessing). Both are stated on screen beside the control they disable.
  const fileSelectionBlocks = !!chosenUpstreamId && (nothingSelected || filesFailed)

  useEffect(() => {
    if (open) return
    setDestination(null)
    setTeamIds([])
    setTeamsError(false)
    form.reset()
    clearSubmitError()
    // AQU-1519: a dialog closed while a create was overrunning must reopen as a
    // fresh, usable form — never still locked. The request it left behind
    // finishes on its own and is not cancelled by the close.
    releaseWork()
    // AQU-712: closing the dialog ends the session — mint a fresh draft id so
    // the next time it opens starts a brand-new project (no false dedup onto a
    // project created in a previous session).
    draftProjectId.current = uuid()
  }, [open, form, clearSubmitError])

  // AQU-1519: arm the overrun escape hatch for exactly as long as the dialog is
  // busy. Disarming is `releaseWork`'s job, not this effect's.
  useEffect(() => {
    if (!locked) return
    const timer = setTimeout(() => setWorkOverran(true), LONG_RUNNING_WORK_MS)
    return () => clearTimeout(timer)
  }, [locked])

  // The page org changed under an open dialog: the old choice is void.
  useEffect(() => {
    setDestination(null)
    setTeamIds([])
    setTeamsError(false)
  }, [orgId])

  function pickShape(next: ProjectShape) {
    form.setFieldValue("shape", next)
    // Shape change clears the corpus answer so a leftover pick from the other
    // shape can't silently satisfy the new path's required choice.
    form.setFieldValue("linkConsumes", "")
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // AQU-1519: the X, Escape and an outside press all arrive here, so one
        // guard covers all three ways out. While the dialog is working it owns
        // the close decision; once the work has overrun it hands it back.
        if (!next && !canClose) return
        setOpen(next)
      }}
    >
      <DialogTrigger render={<Button />}>
        {t("projectSettings.create.trigger")}
      </DialogTrigger>
      <DialogContent closeDisabled={!canClose}>
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
            if (form.state.isSubmitting || locked) return
            void form.handleSubmit()
          }}
          className="contents"
        >
          <DialogBody>
            {/* AQU-1519: one disabled fieldset backs the whole lock — it takes
                every input, radio, select trigger and button inside it out of
                play at once, so a control added to this dialog later (the
                searchable upstream picker of AQU-1518, say) is locked by
                default rather than by remembering to. The explicit `disabled`
                on each control is what Base UI's non-native parts (a radio is
                a <span role="radio">) need on top of it. */}
            <fieldset
              disabled={locked}
              aria-busy={locked}
              data-testid="create-project-fields"
              className="flex min-w-0 flex-col gap-5"
            >
              {open && (
                <ProjectDestinationPicker
                  jwt={session?.jwt}
                  pageOrgId={orgId}
                  onChange={onDestination}
                  disabled={locked}
                />
              )}
              {open && destination?.orgId != null && (
                <ProjectTeamsPicker
                  teams={destination.teams ?? []}
                  required={needTeams}
                  value={teamIds}
                  onValueChange={(next) => {
                    setTeamIds(next)
                    setTeamsError(false)
                  }}
                  showRequiredError={teamsError}
                  disabled={locked}
                />
              )}
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
                          disabled={locked}
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
                          disabled={locked}
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
                          <FieldLabel htmlFor="project-create-target">
                            {t("projectSettings.create.targetLanguagesLabel")}
                          </FieldLabel>
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
                              disabled={locked}
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
                          disabled={locked}
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
                                mode: <strong>{t("projectSettings.create.liveModeName")}</strong>,
                              }}
                            />
                          ) : (
                            <RichMessage
                              k="projectSettings.create.cloneIntro"
                              values={{
                                mode: <strong>{t("projectSettings.create.cloneModeName")}</strong>,
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
                                {/* AQU-1518: searchable, not a scroll-only
                                    dropdown — a long project list made finding
                                    the upstream a scrolling exercise. The picker
                                    still shows the project NAME, never the raw
                                    UUID it stores. */}
                                <ProjectCombobox
                                  id="upstream-project"
                                  options={upstreamOptions}
                                  value={field.state.value}
                                  disabled={locked}
                                  onValueChange={(value) => {
                                    field.handleChange(value)
                                    // Clearing the upstream on self-contained
                                    // drops the corpus question; reset its answer
                                    // so a stale pick can't satisfy a later link.
                                    if (!value) form.setFieldValue("linkConsumes", "")
                                    // AQU-1605: a lane belongs to the upstream it
                                    // was listed from — changing the upstream
                                    // retires the answer, cleared or not.
                                    form.setFieldValue("upstreamLaneId", "")
                                  }}
                                  invalid={invalid}
                                  placeholder={t("projectSettings.create.upstreamProjectPlaceholder")}
                                  searchPlaceholder={t("projectSettings.create.upstreamProjectSearchPlaceholder")}
                                  searchAriaLabel={t("projectSettings.create.upstreamProjectSearchAriaLabel")}
                                  emptyText={t("projectSettings.create.upstreamProjectNoMatches")}
                                  clearText={t("projectSettings.create.upstreamProjectNone")}
                                />
                                {invalid && <FieldError errors={field.state.meta.errors} />}
                              </Field>
                            )
                          }}
                        />

                        {/* AQU-1561: which of the upstream's files to bring
                            in. Same list and same check-all control the Source
                            & sync link flow shows (UpstreamFileChoiceList) —
                            only the sentences differ, because a clone copies
                            once and a live link keeps following. Shown for both
                            shapes: a clone has no second chance to adjust, so
                            the choice has to be here. */}
                        {upstreamProjectId.trim() ? (
                          <Field data-testid="create-upstream-files">
                            <FieldLabel>{t("projectSettings.create.upstreamFilesLabel")}</FieldLabel>
                            {filesFailed ? (
                              // Said, with a way out — never an empty list,
                              // which would read as "that project has no files"
                              // and is a different, creatable situation.
                              <div className="space-y-2">
                                <p className="text-sm text-destructive" role="alert">
                                  {t("projectSettings.create.upstreamFilesLoadError")}
                                </p>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={locked}
                                  onClick={() => {
                                    setFilesFailed(false)
                                    setFilesAttempt((n) => n + 1)
                                  }}
                                >
                                  {t("projectSettings.create.upstreamFilesRetryButton")}
                                </Button>
                              </div>
                            ) : upstreamFiles == null ? (
                              <p className="text-sm text-muted-foreground">
                                {t("projectSettings.create.upstreamFilesLoading")}
                              </p>
                            ) : fileChoices.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                {t("projectSettings.create.upstreamFilesEmptyUpstream")}
                              </p>
                            ) : (
                              <>
                                <UpstreamFileChoiceList
                                  files={fileChoices}
                                  selectedFileIds={selectedFileIds}
                                  onToggleFile={toggleFile}
                                  onToggleAll={(checked) =>
                                    setSelectedFileIds(
                                      checked ? new Set(fileChoices.map((f) => f.id)) : new Set(),
                                    )
                                  }
                                  disabled={locked}
                                />
                                <p
                                  className="text-sm"
                                  role={nothingSelected ? "alert" : undefined}
                                >
                                  {nothingSelected
                                    ? t("projectSettings.create.upstreamFilesNoneSelected")
                                    : t("projectSettings.create.upstreamFilesCount", {
                                        count: selectedCount,
                                      })}
                                </p>
                                {/* What the checkboxes alone do not show: a live
                                    link keeps following the upstream, so whether
                                    it follows the whole project decides what
                                    arrives later too; a clone has no later. */}
                                {!nothingSelected && (
                                  <p className="text-xs text-muted-foreground">
                                    {shape !== "linked-target"
                                      ? t("projectSettings.create.upstreamFilesCloneNote")
                                      : allSelected
                                        ? t("projectSettings.create.upstreamFilesLiveAllNote")
                                        : t("projectSettings.create.upstreamFilesLiveSubsetNote")}
                                  </p>
                                )}
                              </>
                            )}
                          </Field>
                        ) : null}

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
                                        onValueChange={(value) => {
                                          field.handleChange((value ?? "") as LinkConsumes)
                                          // AQU-1605: the lane question belongs to
                                          // the chain case alone.
                                          form.setFieldValue("upstreamLaneId", "")
                                        }}
                                        disabled={locked}
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

                        {/* AQU-1605: which of the upstream's translations
                            becomes this project's source. Chain case only. */}
                        {showCorpusChoice && chosenConsumes === "target" ? (
                          <form.Field
                            name="upstreamLaneId"
                            children={(field) => {
                              const invalid = isFieldInvalid(field)
                              return (
                                <UpstreamLaneChoiceField
                                  id="create-upstream-lane"
                                  lanes={laneOptions}
                                  failed={laneChoices.failed}
                                  value={field.state.value}
                                  onValueChange={(next) => field.handleChange(next)}
                                  onRetry={laneChoices.retry}
                                  disabled={locked}
                                  invalid={invalid}
                                  error={
                                    invalid ? <FieldError errors={field.state.meta.errors} /> : null
                                  }
                                />
                              )
                            }}
                          />
                        ) : null}

                        {showCorpusChoice && (chosenConsumes === "source" || chosenConsumes === "target") ? (
                          <InheritedSettingsChoice
                            title={t("projectSettings.inherit.linkTitle")}
                            description={t("projectSettings.inherit.linkDescription")}
                            receive={inheritReceive}
                            detached={inheritDetached}
                            disabled={locked}
                            onChange={(next) => {
                              setInheritReceive(next.receive)
                              setInheritDetached(next.detached)
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
                                  disabled={locked}
                                  onBusyChange={(busy) => {
                                    if (busy) setWork("adding-lane")
                                    else releaseWork()
                                  }}
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
            </fieldset>
          </DialogBody>

          {/* Outside the scrolling body so an overrunning create always says so
              where the user is already looking — right by the button they are
              waiting on (AQU-1519). */}
          {workOverran && (
            <p
              role="status"
              className="shrink-0 text-xs text-amber-600"
              data-testid="create-taking-long"
            >
              {LONG_RUNNING_WORK_MESSAGE}
            </p>
          )}

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
                  // `locked`, not just `isSubmitting`: the mirror case is a lane
                  // add in flight, which must block Create too (AQU-1519). And no
                  // destination, no create (AQU-1352).
                  // AQU-1561: `fileSelectionBlocks` — an upstream is chosen
                  // but nothing is checked, or its file list could not be read.
                  // The sentence by the list is what this refers to.
                  disabled={isSubmitting || locked || !destination || fileSelectionBlocks}
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
 * case-insensitive duplicate check against registered lanes, then
 * patchProjectSettings with ifMatchVersion. Unlike LanguagesSection this
 * targets the UPSTREAM project (not the project being created), and on
 * success no project is created at all — the dialog just closes.
 */
function AddAsLaneRecommendation({
  jwt,
  upstreamProject,
  targetLanguage,
  onAdded,
  onBusyChange,
  disabled = false,
}: {
  jwt: string | undefined
  upstreamProject: CloudProjectSummary | null
  targetLanguage: string
  onAdded: () => void
  /** AQU-1519: lifts this panel's in-flight state to the dialog so a lane add
   *  locks the whole modal, exactly as a create does. */
  onBusyChange: (busy: boolean) => void
  /** AQU-1519: true while the dialog is busy with anything at all — a create in
   *  flight, or this panel's own lane add. */
  disabled?: boolean
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

  /** Every failure path: surface it AND release the dialog-wide lock, so a
   *  failed lane add leaves a usable form behind (AQU-1519). */
  function fail(reason: string) {
    setStatus("error")
    setMessage(reason)
    onBusyChange(false)
  }

  async function handleAddAsLane() {
    const project = upstreamProject
    if (!project) return
    // Both of these are validation, checked before anything locks.
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
    onBusyChange(true)
    try {
      const current = await fetchProjectSettings(jwt, project.id)
      const existing = (current?.lanes ?? []).filter((lane) => lane.role === "target")
      const known = existing
        .map((lane) =>
          laneLanguage(lane, {
            settings: current?.settings,
            role: "target",
            legacyTag: lane.legacyTag,
          }),
        )
        .filter((language) => language.length > 0)
      const registry = known.length > 0 ? known : (current?.settings.targetLanes ?? [])
      const already = registry.some((language) => isPrimaryRegistryLane(trimmed, language))
      if (already) {
        fail(`"${trimmed}" is already a lane on ${project.name}.`)
        return
      }

      const result = await createProjectLane(jwt, project.id, { name: "", language: trimmed })
      if (result.kind === "ok") {
        setStatus("success")
        setMessage(`Added "${trimmed}" as a lane on ${project.name}. Open that project to start translating.`)
        posthog.capture("sibling lane added from create dialog", {
          upstream_project_id: project.id,
          lane: trimmed,
        })
        // Give the success hint a beat on screen, then close — no project
        // was created, so there's nothing else for this dialog to do. The lock
        // stays on through that beat; closing the dialog releases it.
        closeTimerRef.current = setTimeout(onAdded, 900)
        return
      }
      if (result.kind === "duplicate") {
        fail(`"${trimmed}" is already a lane on ${project.name}.`)
        return
      }
      if (result.kind === "error" && result.message.includes("(403)")) {
        fail(`You need maintainer access on ${project.name} to add a lane there.`)
        return
      }
      fail("Couldn't add the lane. Please try again.")
    } catch (err) {
      fail(err instanceof Error ? err.message : "Couldn't add the lane. Please try again.")
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
          disabled={disabled || !canAttempt || status === "loading"}
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
 * AQU-538 / AQU-1240: the self-contained shape's target field is one text
 * box per lane, stacked, with a plus button that appends another. Box 0 is
 * the project's targetLanguage and the first settings.targetLanes entry;
 * later boxes are the remaining registry extras.
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
  disabled = false,
}: {
  onPrimaryChange: (next: string) => void
  onExtrasChange: (next: string[]) => void
  onBlur?: () => void
  invalid?: boolean
  /** AQU-1519: locked while the dialog is working. */
  disabled?: boolean
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
                disabled={disabled}
              />
              {index > 0 && (
                <button
                  type="button"
                  aria-label={t("projectSettings.create.extraLanguagesRemoveAriaLabel", {
                    lang: lane.value.trim() || String(index + 1),
                  })}
                  data-testid={`create-target-lang-remove-${index}`}
                  disabled={disabled}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100 disabled:pointer-events-none disabled:opacity-40"
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
            disabled={disabled}
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
            disabled={disabled || !canAddMore}
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
