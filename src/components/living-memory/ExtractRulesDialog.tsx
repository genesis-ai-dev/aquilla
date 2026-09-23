/**
 * "Extract from knowledge base" dialog (AQU-934 phase 2).
 *
 * Picks one indexed knowledge document, walks its leaf sections through the
 * extractor, then posts each surviving candidate as a `proposed` rule carrying
 * its citation. `scopeHint` → rule scope mapping (the scope ladder is
 * global → genre → document → section → passage → segment):
 *   "global"   → scope "global", no applicability row
 *   "genre:x"  → scope "genre",    row { targetType: "genre", … }
 *   "book:PSA" → scope "document", row { targetType: "book",  … }
 *   "file:id"  → scope "document", row { targetType: "file",  … }
 * A book and a file are both ONE document, so both land on "document"; the row
 * carries the finer address. Initial rows are `likely_applies` / `model` — a
 * hint, never a human decision.
 */

import { useEffect, useRef, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatCount } from "@/lib/i18n/format"
import type { KnowledgeDocument, KnowledgeScope } from "@/lib/frontier/knowledge-base"
import { getKnowledgeDocument } from "@/lib/frontier/knowledge-base"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CompletionSettings } from "@/lib/parsers/types"
import {
  extractStyleRulesFromDoc,
  flattenLeafNodes,
} from "@/lib/rules/style-rule-extractor"
import type {
  CreateStyleRuleInput,
  StyleRule,
  StyleRuleScope,
  UpsertApplicabilityInput,
} from "@/lib/rules/style-rule-types"

type Phase = "pick" | "running" | "done"

interface ParsedHint {
  scope: StyleRuleScope
  row?: UpsertApplicabilityInput
}

/** `"<targetType>:<targetId>"` → rule scope + the initial model-assigned row. */
function parseScopeHint(hint: string): ParsedHint {
  const separator = hint.indexOf(":")
  if (separator <= 0) return { scope: "global" }
  const targetId = hint.slice(separator + 1).trim()
  if (!targetId) return { scope: "global" }
  const base = { targetId, relationship: "likely_applies", assignedBy: "model" } as const
  switch (hint.slice(0, separator)) {
    case "genre":
      return { scope: "genre", row: { targetType: "genre", ...base } }
    case "book":
      return { scope: "document", row: { targetType: "book", ...base } }
    case "file":
      return { scope: "document", row: { targetType: "file", ...base } }
    default:
      return { scope: "global" }
  }
}

function candidateToInput(
  found: Awaited<ReturnType<typeof extractStyleRulesFromDoc>>[number],
  docId: string,
): CreateStyleRuleInput {
  const { candidate } = found
  const { scope, row } = parseScopeHint(candidate.scopeHint)
  const input: CreateStyleRuleInput = {
    instruction: candidate.instruction,
    category: candidate.category,
    scope,
    source: { kind: "knowledge-doc", docId, nodeId: found.nodeId, quote: found.quote },
  }
  if (candidate.conditions) input.conditions = candidate.conditions
  if (candidate.exceptions) input.exceptions = candidate.exceptions
  if (candidate.examples) input.examples = candidate.examples
  if (candidate.checkSpec) input.checkSpec = candidate.checkSpec
  if (row) input.applicability = [row]
  return input
}

interface ExtractRulesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: KnowledgeScope
  jwt: string | null
  docs: KnowledgeDocument[]
  settings?: CompletionSettings
  session: FrontierSession | null
  onCreate: (input: CreateStyleRuleInput) => Promise<StyleRule | null>
  /** Called once the dialog closes, so the review queue refetches. */
  onFinished: () => void
}

export function ExtractRulesDialog({
  open,
  onOpenChange,
  scope,
  jwt,
  docs,
  settings,
  session,
  onCreate,
  onFinished,
}: ExtractRulesDialogProps) {
  const t = useT()
  const { locale } = useI18n()
  const readyDocs = docs.filter((doc) => doc.indexStatus === "ready")
  const [docId, setDocId] = useState("")
  const [phase, setPhase] = useState<Phase>("pick")
  const [progress, setProgress] = useState({ current: 0, total: 0, found: 0 })
  const [saved, setSaved] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) return
    // Closing mid-run must stop the walk; state resets for the next open.
    abortRef.current?.abort()
    abortRef.current = null
    setPhase("pick")
    setProgress({ current: 0, total: 0, found: 0 })
    setSaved(0)
    setError(null)
  }, [open])

  const firstReadyDocId = readyDocs[0]?.id ?? ""
  useEffect(() => {
    if (!open || !firstReadyDocId) return
    setDocId((current) => current || firstReadyDocId)
  }, [open, firstReadyDocId])

  const canStart = Boolean(jwt && settings && docId)

  async function run() {
    if (!jwt || !settings || !docId) return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase("running")
    setError(null)
    setSaved(0)
    setProgress({ current: 0, total: 0, found: 0 })
    try {
      const { tree } = await getKnowledgeDocument(scope, jwt, docId)
      const nodes = flattenLeafNodes(tree ?? [])
      const found = await extractStyleRulesFromDoc({
        scope,
        docId,
        nodes,
        jwt,
        settings,
        session,
        signal: controller.signal,
        onProgress: (current, total, foundCount) =>
          setProgress({ current, total, found: foundCount }),
      })
      let created = 0
      for (const item of found) {
        if (controller.signal.aborted) break
        if (await onCreate(candidateToInput(item, docId))) created += 1
      }
      setSaved(created)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err))
    } finally {
      abortRef.current = null
      setPhase("done")
    }
  }

  function close() {
    abortRef.current?.abort()
    onOpenChange(false)
    onFinished()
  }

  const docItems = Object.fromEntries(readyDocs.map((doc) => [doc.id, doc.name]))

  return (
    <Dialog open={open} onOpenChange={(next: boolean) => { if (!next) close() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("terminology.livingMemory.styleRules.extract.title")}</DialogTitle>
          <DialogDescription>
            {t("terminology.livingMemory.styleRules.extract.description")}
          </DialogDescription>
        </DialogHeader>

        {readyDocs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("terminology.livingMemory.styleRules.extract.noDocs")}
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor="extract-doc">
              {t("terminology.livingMemory.styleRules.extract.docLabel")}
            </FieldLabel>
            <Select
              items={docItems}
              value={docId}
              onValueChange={(value) => setDocId(String(value ?? ""))}
            >
              <SelectTrigger id="extract-doc" disabled={phase === "running"}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {readyDocs.map((doc) => (
                    <SelectItem key={doc.id} value={doc.id}>
                      {doc.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}

        {!settings && readyDocs.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("terminology.livingMemory.styleRules.extract.needsModel")}
          </p>
        ) : null}

        {phase === "running" ? (
          <div className="flex flex-col gap-1" role="status">
            <p className="text-xs text-muted-foreground">
              {t("terminology.livingMemory.styleRules.extract.progress", {
                current: formatCount(progress.current, locale),
                total: formatCount(progress.total, locale),
              })}
            </p>
            <p className="text-xs text-muted-foreground/70">
              {t("terminology.livingMemory.styleRules.extract.found", {
                count: formatCount(progress.found, locale),
              })}
            </p>
          </div>
        ) : null}

        {phase === "done" && !error ? (
          <p className="text-xs text-muted-foreground" role="status">
            {saved > 0
              ? t("terminology.livingMemory.styleRules.extract.saved", {
                  count: formatCount(saved, locale),
                })
              : t("terminology.livingMemory.styleRules.extract.none")}
          </p>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 text-xs text-destructive" role="alert">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span>
              {t("terminology.livingMemory.styleRules.extract.failed", { message: error })}
            </span>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {phase === "done" ? t("common.done") : t("common.cancel")}
          </Button>
          {phase !== "done" ? (
            <Button disabled={!canStart || phase === "running"} onClick={() => void run()}>
              {t("terminology.livingMemory.styleRules.extract.start")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
