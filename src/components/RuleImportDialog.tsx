/**
 * RuleImportDialog — FRO-196
 *
 * "Import from document" entry on the Rules surface.
 * Accepts paste or dropped .txt/.md files, enforces 200 KB size cap,
 * then runs two LLM passes (extract candidates → structure rules).
 */

import { useState, useRef, useCallback } from "react"
import { Upload, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { RuleImportReview } from "./RuleImportReview"
import {
  checkInputSize,
  extractRulesFromDocument,
  type ExtractionProgress,
} from "@/lib/rules/rule-extractor"
import { addLlmCall } from "@/lib/usage/record-usage"
import { getProject, updateProject } from "@/lib/store/project-index"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/completion/completion-service"
import { useFrontierHealth } from "@/lib/completion/frontier-health"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { CompletionSettings, TranslationRule } from "@/lib/parsers/types"
import type { RuleSuggestion } from "@/lib/rules/rule-suggester"

// SWARM-TODO(FRO-197): accept pdf/docx via worker parse (see FRO-197)
const ACCEPTED_TEXT_TYPES = [".txt", ".md"]
const ACCEPTED_MIME = ["text/plain", "text/markdown"]

const FALLBACK_SETTINGS: CompletionSettings = {
  provider: "frontier",
  endpoint: "",
  model: "",
  maxTokens: 2048,
  temperature: 0.1,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  llmHealthPenalty: 0.1,
}

interface Props {
  completionSettings: CompletionSettings | undefined
  onAdd: (rule: Omit<TranslationRule, "id" | "createdAt">) => void | Promise<void>
  projectId?: string
}

type Stage = "idle" | "extracting" | "review"

export function RuleImportDialog({ completionSettings, onAdd, projectId }: Props) {
  const { session } = useFrontierSession()
  const { available: frontierAvailable } = useFrontierHealth()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<Stage>("idle")
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ExtractionProgress | null>(null)
  const [drafts, setDrafts] = useState<RuleSuggestion[]>([])
  const [committing, setCommitting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // SWARM-TODO: if RulesSurface doesn't receive completionSettings as a prop,
  // this dialog falls back to FALLBACK_SETTINGS (frontier provider).
  // FRO-195 owns ProjectWorkspace — once it threads completionSettings through,
  // remove the fallback.
  const effectiveSettings = completionSettings ?? FALLBACK_SETTINGS

  const provider = effectiveSettings.provider || "frontier"
  const isConfigured =
    provider === "frontier"
      ? Boolean(session?.jwt) && frontierAvailable
      : Boolean(effectiveSettings.endpoint && effectiveSettings.model)

  async function runExtraction(text: string) {
    const sizeCheck = checkInputSize(text)
    if (!sizeCheck.ok) {
      setError(sizeCheck.message)
      return
    }
    setStage("extracting")
    setError(null)
    setProgress({ phase: "extracting", candidateCount: 0, structuredCount: 0 })

    try {
      const results = await extractRulesFromDocument(
        text,
        effectiveSettings,
        session,
        (p) => setProgress(p),
        async (meta) => {
          if (!projectId) return
          const current = await getProject(projectId)
          if (!current) return
          await updateProject(addLlmCall(current, meta))
        },
      )

      if (results.length === 0) {
        setError("No verifiable rules found in the document. Try a style guide or glossary.")
        setStage("idle")
        return
      }

      setDrafts(results)
      setStage("review")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed")
      setStage("idle")
    }
  }

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData.getData("text/plain")
      if (!text.trim()) return
      e.preventDefault()
      runExtraction(text)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveSettings, session, projectId],
  )

  function handleFileAccepted(file: File) {
    // SWARM-TODO(FRO-197): accept pdf/docx via worker parse
    const ext = file.name.toLowerCase()
    const ok =
      ACCEPTED_MIME.includes(file.type) ||
      ACCEPTED_TEXT_TYPES.some((e) => ext.endsWith(e))
    if (!ok) {
      setError(`Unsupported file type. Drop a .txt or .md file. (PDF/DOCX: FRO-197)`)
      return
    }
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      if (!text?.trim()) {
        setError("File appears to be empty.")
        return
      }
      runExtraction(text)
    }
    reader.readAsText(file)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFileAccepted(file)
  }

  async function handleCommit(acceptedIndices: number[]) {
    setCommitting(true)
    try {
      for (const i of acceptedIndices) {
        const draft = drafts[i]
        if (!draft) continue
        await onAdd({
          name: draft.name,
          description: draft.description,
          severity: draft.severity,
          source: "llm",
          scope: "project",
          check: draft.check,
          enabled: true,
        })
      }
    } finally {
      setCommitting(false)
      setOpen(false)
      resetState()
    }
  }

  function resetState() {
    setStage("idle")
    setError(null)
    setProgress(null)
    setDrafts([])
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) resetState()
  }

  function progressLabel(): string {
    if (!progress) return "Starting…"
    if (progress.phase === "extracting") return "Extracting rules from document…"
    const { candidateCount, structuredCount } = progress
    return `Structuring ${structuredCount} / ${candidateCount} rules…`
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={!isConfigured}
            title={
              isConfigured
                ? "Import rules from a document"
                : "Configure LLM in settings first"
            }
          >
            <Upload className="mr-1 h-3.5 w-3.5" />
            Import from doc
          </Button>
        }
      />

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {stage === "review"
              ? `Review ${drafts.length} extracted rule${drafts.length !== 1 ? "s" : ""}`
              : "Import rules from document"}
          </DialogTitle>
        </DialogHeader>

        {stage === "idle" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Drop a style guide, glossary, or translation guidelines document and the
              LLM will extract structured rules you can review and accept.
              Supports plain text and Markdown (max 200 KB).
            </p>

            {/* Drop zone */}
            <div
              className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors ${
                dragOver
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/30 bg-muted/20"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <Upload className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground text-center">
                Drop a <strong>.txt</strong> or <strong>.md</strong> file here
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Browse file
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFileAccepted(file)
                  // reset so re-selecting same file fires again
                  e.target.value = ""
                }}
              />
            </div>

            {/* Paste zone */}
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Or paste document text:</p>
              <textarea
                className="w-full min-h-[80px] rounded border bg-background p-2 text-xs font-mono resize-y focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                placeholder="Paste text here and it will be processed automatically…"
                onPaste={handlePaste}
                readOnly={false}
                rows={4}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {!isConfigured && (
              <p className="text-xs text-muted-foreground">
                Configure your LLM endpoint in project settings first.
              </p>
            )}
          </div>
        )}

        {stage === "extracting" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{progressLabel()}</p>
            {progress && progress.phase === "structuring" && progress.candidateCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {progress.structuredCount} of {progress.candidateCount} candidates processed
              </p>
            )}
          </div>
        )}

        {stage === "review" && (
          <RuleImportReview
            drafts={drafts}
            onCommit={handleCommit}
            onBack={() => setStage("idle")}
            committing={committing}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
