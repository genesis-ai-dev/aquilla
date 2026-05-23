import { useMemo, useState } from "react"
import { v4 as uuid } from "uuid"
import { Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { createProject as createLocalProject } from "@/lib/store/project-index"
import { createProject as createRemoteProject } from "@aquilla/api-client"
import type { ProjectRecord } from "@/lib/parsers/types"
import posthog from "@/lib/posthog"
import { useAccessibleProjects } from "@/hooks/useAccessibleProjects"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { linkProjectToSource, SourceLinkingError } from "@/lib/sync/source-linking-read"

interface ProjectCreateDialogProps {
  onCreated: (project: ProjectRecord) => void
}

/**
 * Three project shapes per AD-9:
 *
 *  - self-contained: owns its source and its target (default).
 *  - source-only:    `targetLanguage` left blank; the project exists to
 *                    be linked-against by other target projects.
 *  - linked-target:  reads source from another project; this form
 *                    requires picking an upstream at creation time.
 */
type ProjectShape = "self-contained" | "source-only" | "linked-target"

export function ProjectCreateDialog({ onCreated }: ProjectCreateDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")
  const [shape, setShape] = useState<ProjectShape>("self-contained")
  const [sourceProjectId, setSourceProjectId] = useState<string>("")
  const [submitting, setSubmitting] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  const { session } = useFrontierSession()
  const { projects: accessible } = useAccessibleProjects()
  const sourceCandidates = useMemo(
    () => accessible.filter((p) => p.role.level >= 100),
    [accessible],
  )

  // Reset transient state when the dialog closes. We do this in the
  // onOpenChange handler (rather than a useEffect) to avoid
  // react-hooks/set-state-in-effect.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setLinkError(null)
      setSubmitting(false)
    }
    setOpen(next)
  }

  // Switching shape clears irrelevant fields so the next submit has a
  // clean record. Done in the radio onChange handler below instead of a
  // useEffect for the same reason.
  function pickShape(next: ProjectShape) {
    setShape(next)
    if (next !== "linked-target") setSourceProjectId("")
    if (next === "source-only") setTargetLanguage("")
  }

  function reset() {
    setName("")
    setSourceLanguage("")
    setTargetLanguage("")
    setShape("self-contained")
    setSourceProjectId("")
    setLinkError(null)
  }

  function canSubmit(): boolean {
    if (!name.trim() || !sourceLanguage.trim()) return false
    if (shape === "self-contained" || shape === "linked-target") {
      if (!targetLanguage.trim()) return false
    }
    if (shape === "linked-target" && !sourceProjectId) return false
    return true
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit()) return
    setSubmitting(true)
    setLinkError(null)

    const id = uuid()
    let project: ProjectRecord = {
      id,
      name: name.trim(),
      sourceLanguage: sourceLanguage.trim(),
      // Source-only projects intentionally have no target language —
      // distinguishes them in AD-9's project-shape table.
      targetLanguage: shape === "source-only" ? "" : targetLanguage.trim(),
      createdAt: new Date().toISOString(),
      files: [],
      members: [{ userId: "local", role: "owner" }],
      ...(shape === "linked-target" && sourceProjectId
        ? {
            sourceProjectId,
            sourceProjectName:
              accessible.find((p) => p.id === sourceProjectId)?.name,
          }
        : {}),
    }

    if (session?.jwt) {
      const created = await createRemoteProject(
        { id: project.id, name: project.name },
        session.jwt,
      )
      project = {
        ...project,
        syncRole: {
          ...created.role,
          source: created.role.source,
          fetchedAt: new Date().toISOString(),
        },
      }
    }

    await createLocalProject(project)
    posthog.capture("project created", {
      project_id: project.id,
      project_shape: shape,
      source_language: project.sourceLanguage,
      target_language: project.targetLanguage,
      has_source_link: shape === "linked-target",
    })

    // Linked-target: best-effort durable link via auth-worker. The local
    // record was already written with `sourceProjectId`, so even if the
    // server call fails (offline, transient 5xx) the UI shows the link;
    // the user can re-link from Project Settings.
    if (shape === "linked-target" && sourceProjectId && session?.jwt) {
      try {
        await linkProjectToSource(project.id, sourceProjectId, session.jwt)
      } catch (err) {
        // Errors here don't block the create — the project is already in
        // IDB and surfaced. We just record the failure for the user to
        // investigate later. SourceLinkingError carries an HTTP status.
        if (err instanceof SourceLinkingError) {
          setLinkError(
            err.status === 409
              ? "Project created, but the source link couldn't be applied (server rejected it — try Settings > Source linking)."
              : `Project created, but the source link couldn't be applied (HTTP ${err.status}). Try Settings > Source linking.`,
          )
        } else {
          setLinkError(
            "Project created, but the source link couldn't be applied. Try Settings > Source linking.",
          )
        }
        // Don't return — still close on success-create so the dashboard updates.
      }
    }

    onCreated(project)
    setSubmitting(false)
    if (!linkError) {
      reset()
      handleOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button />}>+ New Project</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Project Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Translation Project"
            />
          </div>

          {/* AD-9 project-shape picker, tucked behind an "Advanced" disclosure
              so the dashboard create flow shows only name + languages by
              default. Self-contained is the assumed shape and matches the
              VS-Code-extension muscle memory. */}
          <details className="rounded-xl border px-3 py-2 [&[open]>summary]:mb-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
              Advanced: project shape
            </summary>
            <fieldset className="space-y-2 pt-1">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="shape"
                  className="mt-1"
                  checked={shape === "self-contained"}
                  onChange={() => pickShape("self-contained")}
                />
                <span>
                  <strong>Self-contained</strong> (default) — owns its source
                  and its target. The most common shape.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="shape"
                  className="mt-1"
                  checked={shape === "source-only"}
                  onChange={() => pickShape("source-only")}
                />
                <span>
                  <strong>Source-only</strong> — a canonical source other
                  projects link against. No target language is set.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="shape"
                  className="mt-1"
                  checked={shape === "linked-target"}
                  onChange={() => pickShape("linked-target")}
                />
                <span>
                  <strong>Linked target</strong> — reads source from another
                  project; this one only owns its target side.
                </span>
              </label>
            </fieldset>
          </details>

          <div>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="source">Source Language</Label>
              <LanguageFieldHint />
            </div>
            <Input
              id="source"
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
              placeholder="e.g. English, Grade 7 English, es-419"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              The language or variety you're translating <em>from</em>.
            </p>
          </div>

          {shape !== "source-only" && (
            <div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="target">Target Language</Label>
                <LanguageFieldHint />
              </div>
              <Input
                id="target"
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                placeholder="e.g. French, conversational Swahili, zh-Hant"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                The language or variety you're translating <em>into</em>.
              </p>
            </div>
          )}

          {shape === "linked-target" && (
            <div>
              <Label htmlFor="src-project">Upstream source project</Label>
              <select
                id="src-project"
                value={sourceProjectId}
                onChange={(e) => setSourceProjectId(e.target.value)}
                className="w-full rounded border bg-background px-3 py-2 text-sm"
              >
                <option value="">Select a source project…</option>
                {sourceCandidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Source cells will be read from this project. You can detach
                later from Project Settings.
              </p>
            </div>
          )}

          {linkError && (
            <p role="alert" className="text-sm text-destructive">
              {linkError}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={!canSubmit() || submitting}>
            {submitting ? "Creating…" : "Create Project"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LanguageFieldHint() {
  return (
    <TooltipProvider delay={150}>
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
    </TooltipProvider>
  )
}
