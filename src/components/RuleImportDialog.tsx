/**
 * RuleImportDialog — AQU-196
 *
 * "Import from document" entry on the Rules surface.
 * Accepts paste or dropped .txt/.md files, enforces 200 KB size cap,
 * then runs two LLM passes (extract candidates → structure rules).
 */

import { useState, useRef, useCallback } from "react"
import { Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
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
import { parseDocumentFile, MAX_PARSE_FILE_BYTES } from "@/lib/frontier/parse-document"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

const ACCEPTED_TEXT_TYPES = [".txt", ".md"]
const ACCEPTED_MIME = ["text/plain", "text/markdown"]
const ACCEPTED_BINARY_TYPES = [".pdf", ".docx"]
const ACCEPTED_BINARY_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]

const MAX_TEXT_BYTES = 200 * 1024 // 200 KB (existing limit for text)

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
  const t = useT()
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
  // AQU-195 owns ProjectWorkspace — once it threads completionSettings through,
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
        setError(t("rules.importDialog.noRulesFound"))
        setStage("idle")
        return
      }

      setDrafts(results)
      setStage("review")
    } catch (err) {
      setError(err instanceof Error ? err.message : t("rules.importDialog.extractionFailed"))
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
    const ext = file.name.toLowerCase()
    const isText =
      ACCEPTED_MIME.includes(file.type) ||
      ACCEPTED_TEXT_TYPES.some((e) => ext.endsWith(e))
    const isBinary =
      ACCEPTED_BINARY_MIME.includes(file.type) ||
      ACCEPTED_BINARY_TYPES.some((e) => ext.endsWith(e))

    if (!isText && !isBinary) {
      setError(t("rules.importDialog.unsupportedFileType"))
      return
    }

    if (isBinary) {
      // Client-side size cap before upload
      if (file.size > MAX_PARSE_FILE_BYTES) {
        setError(
          t("rules.importDialog.binaryFileTooLarge", { size: (file.size / 1024 / 1024).toFixed(1) }),
        )
        return
      }
      const jwt = session?.jwt
      if (!jwt) {
        setError(t("rules.importDialog.signInRequiredForBinary"))
        return
      }
      setStage("extracting")
      setError(null)
      setProgress({ phase: "extracting", candidateCount: 0, structuredCount: 0 })
      parseDocumentFile(file, jwt)
        .then((text) => {
          // Reset stage so runExtraction can set it again
          setStage("idle")
          return runExtraction(text)
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : t("rules.importDialog.couldNotParseFile"))
          setStage("idle")
        })
      return
    }

    // Plain text / markdown: existing path
    if (file.size > MAX_TEXT_BYTES) {
      setError(
        t("rules.importDialog.textFileTooLarge", { size: (file.size / 1024).toFixed(0) }),
      )
      return
    }
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      if (!text?.trim()) {
        setError(t("rules.importDialog.fileEmpty"))
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
    if (!progress) return t("autopilot.pill.starting")
    if (progress.phase === "extracting") return t("rules.importDialog.extractingRules")
    const { candidateCount, structuredCount } = progress
    return t("rules.importDialog.structuring", { structured: structuredCount, candidates: candidateCount })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <AppTooltip
        content={
          isConfigured
            ? t("rules.importDialog.tooltip")
            : t("rules.importDialog.tooltipUnconfigured")
        }
      >
        {/* Span wrapper so the tooltip still receives hover when the button is disabled. */}
        <span className="inline-flex">
          <DialogTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                disabled={!isConfigured}
              />
            }
          >
            <Upload className="me-1 h-3.5 w-3.5" />
            {t("rules.importDialog.triggerButton")}
          </DialogTrigger>
        </span>
      </AppTooltip>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {stage === "review"
              ? t("rules.importDialog.reviewTitle", { count: drafts.length })
              : t("rules.importDialog.title")}
          </DialogTitle>
        </DialogHeader>

        {stage === "idle" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("rules.importDialog.description")}
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
                <RichMessage
                  k="rules.importDialog.dropZoneText"
                  values={{
                    txt: <strong>.txt</strong>,
                    md: <strong>.md</strong>,
                    pdf: <strong>.pdf</strong>,
                    docx: <strong>.docx</strong>,
                  }}
                />
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                {t("rules.importDialog.browseButton")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
              <p className="text-xs text-muted-foreground">{t("rules.importDialog.pasteZoneLabel")}</p>
              <Textarea
                className="min-h-[80px] font-mono resize-y"
                placeholder={t("rules.importDialog.pastePlaceholder")}
                onPaste={handlePaste}
                readOnly={false}
                rows={4}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {!isConfigured && (
              <p className="text-xs text-muted-foreground">
                {t("rules.importDialog.configureLlmFirst")}
              </p>
            )}
          </div>
        )}

        {stage === "extracting" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Spinner className="size-6 text-primary" />
            <p className="text-sm text-muted-foreground">{progressLabel()}</p>
            {progress && progress.phase === "structuring" && progress.candidateCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("rules.importDialog.candidatesProcessed", {
                  structured: progress.structuredCount,
                  candidates: progress.candidateCount,
                })}
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
