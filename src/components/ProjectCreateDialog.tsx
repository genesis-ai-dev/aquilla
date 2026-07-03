import { useState } from "react"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { createProject } from "@/lib/store/project-index"
import { createCloudProject } from "@/lib/sync/cloud-projects"
import { patchProjectSettings } from "@/lib/sync/project-settings"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ProjectRecord } from "@/lib/parsers/types"
import posthog from "@/lib/posthog"

interface ProjectCreateDialogProps {
  onCreated: (project: ProjectRecord) => void
  /** Scope the new project to a specific org. Omit for personal/default org. */
  orgId?: number
}

/**
 * Three project shapes per AD-9:
 *  - self-contained: owns its source and target (default).
 *  - source-only:    targetLanguage left blank; exists to be linked-against.
 *  - linked-target:  reads source from another project (shape recorded locally).
 */
type ProjectShape = "self-contained" | "source-only" | "linked-target"

/**
 * Per-field overrides for this dialog: a touch taller with more horizontal
 * padding so long example placeholders aren't crowded against the edges, and a
 * softer focus ring (the global 3px/50% ring read as a halo that obscured the
 * field text). tailwind-merge lets these win over the base Input classes.
 */
const FIELD_CLASS = "h-9 px-3 focus-visible:ring-2 focus-visible:ring-ring/35"

export function ProjectCreateDialog({ onCreated, orgId }: ProjectCreateDialogProps) {
  const { session } = useFrontierSession()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")
  const [shape, setShape] = useState<ProjectShape>("self-contained")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function pickShape(next: ProjectShape) {
    setShape(next)
    if (next === "source-only") setTargetLanguage("")
  }

  function canSubmit(): boolean {
    if (!name.trim() || !sourceLanguage.trim()) return false
    if (shape !== "source-only" && !targetLanguage.trim()) return false
    return true
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit() || submitting) return
    setError(null)

    const jwt = session?.jwt
    if (!jwt) {
      setError("You need to be signed in to create a project.")
      return
    }

    const project: ProjectRecord = {
      id: uuid(),
      name: name.trim(),
      sourceLanguage: sourceLanguage.trim(),
      targetLanguage: shape === "source-only" ? "" : targetLanguage.trim(),
      createdAt: new Date().toISOString(),
      files: [],
      members: [{ userId: session.username, role: "owner" }],
    }

    setSubmitting(true)
    try {
      // Create the SERVER row first — reads are server-only (AD-3), so without
      // it the project 403s the moment you open it. This must succeed before
      // we cache locally or navigate.
      await createCloudProject(jwt, { id: project.id, name: project.name, orgId })
      // Persist the languages the user just typed (creator is owner/700, well
      // above the maintainer(600) write gate). Best-effort: a project that
      // exists but lacks languages is still openable.
      try {
        await patchProjectSettings(jwt, project.id, {
          sourceLanguage: project.sourceLanguage,
          targetLanguage: project.targetLanguage,
        }, 0)
      } catch (err) {
        console.warn("[project-create] settings write failed (non-fatal):", err)
      }
    } catch (err) {
      console.error("[project-create] failed:", err)
      setError(err instanceof Error ? err.message : "Failed to create project. Please try again.")
      setSubmitting(false)
      return
    }

    await createProject(project)
    posthog.capture("project created", {
      project_id: project.id,
      project_shape: shape,
      source_language: project.sourceLanguage,
      target_language: project.targetLanguage,
    })
    setSubmitting(false)
    onCreated(project)
    setName("")
    setSourceLanguage("")
    setTargetLanguage("")
    setShape("self-contained")
    setError(null)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>+ New Project</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="name">Project name</Label>
            <Input
              id="name"
              className={FIELD_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Translation Project"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="source" layout="inline">Source language</Label>
              <LanguageFieldHint />
            </div>
            <Input
              id="source"
              className={FIELD_CLASS}
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
              placeholder="English, Grade 7 English, es-419…"
            />
          </div>

          {shape !== "source-only" && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="target" layout="inline">Target language</Label>
                <LanguageFieldHint />
              </div>
              <Input
                id="target"
                className={FIELD_CLASS}
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                placeholder="French, conversational Swahili, zh-Hant…"
              />
            </div>
          )}

          {/* AD-9 project-shape picker, tucked behind an "Advanced" disclosure
              and placed after the primary fields so the default create flow is
              just name + languages. Self-contained is the assumed shape and
              matches the VS-Code-extension muscle memory. */}
          <details className="rounded-xl border px-3 py-2.5 [&[open]>summary]:mb-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
              Advanced: project shape
            </summary>
            <RadioGroup
              value={shape}
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
          </details>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button
            type="submit"
            className="h-9 w-full"
            disabled={!canSubmit() || submitting}
          >
            {submitting ? "Creating…" : "Create Project"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
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
