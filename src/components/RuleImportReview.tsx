/**
 * RuleImportReview — FRO-196
 *
 * Generic review screen for a list of RuleSuggestion drafts.
 * Designed to be reusable by FRO-198 and future import flows.
 *
 * Props:
 *   drafts    — structured rule suggestions to review
 *   evidence  — optional per-draft reason/evidence string (index-aligned)
 *   onCommit  — called with accepted draft indices; consumer calls addRule
 *   onBack    — called when user clicks "Back"
 */

import { useState } from "react"
import { AlertTriangle, AlertCircle, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { RuleSuggestion } from "@/lib/rules/rule-suggester"

export interface RuleImportReviewProps {
  drafts: RuleSuggestion[]
  /** Optional per-draft evidence/reason string (same index as drafts). */
  evidence?: string[]
  onCommit: (accepted: number[]) => void | Promise<void>
  onBack: () => void
  committing?: boolean
}

export function RuleImportReview({
  drafts,
  evidence,
  onCommit,
  onBack,
  committing = false,
}: RuleImportReviewProps) {
  const [accepted, setAccepted] = useState<Set<number>>(
    () => new Set(drafts.map((_, i) => i)),
  )
  // Minimal inline edit: name override per draft
  // SWARM-TODO(FRO-195): use shared RuleEditor for richer editing
  const [nameOverrides, setNameOverrides] = useState<Record<number, string>>({})

  function toggleAccept(i: number) {
    setAccepted((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  function handleCommit() {
    onCommit([...accepted])
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {drafts.length} rule draft{drafts.length !== 1 ? "s" : ""} extracted. Toggle to include or exclude.
      </p>

      <ul className="max-h-[400px] overflow-auto space-y-2">
        {drafts.map((draft, i) => {
          const isAccepted = accepted.has(i)
          const Icon = draft.severity === "major" ? AlertTriangle : AlertCircle
          const sevColor = draft.severity === "major" ? "text-red-500" : "text-amber-500"
          const badgeColor =
            draft.severity === "major"
              ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
              : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"

          return (
            <li
              key={i}
              className={`rounded border p-3 transition-opacity ${isAccepted ? "" : "opacity-40"}`}
            >
              <div className="flex items-start gap-2">
                <Icon className={`h-4 w-4 flex-shrink-0 mt-0.5 ${sevColor}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Minimal inline name edit */}
                    <Input
                      className="h-6 text-sm font-medium px-1 py-0 border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:border-b focus-visible:border-muted min-w-0 flex-1"
                      value={nameOverrides[i] ?? draft.name}
                      onChange={(e) =>
                        setNameOverrides((prev) => ({ ...prev, [i]: e.target.value }))
                      }
                      disabled={!isAccepted}
                    />
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor}`}>
                      {draft.severity}
                    </span>
                  </div>
                  {draft.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground break-words">
                      {draft.description}
                    </p>
                  )}
                  <div className="mt-1 rounded bg-muted/50 p-1.5">
                    <p className="font-mono text-[11px] leading-relaxed break-all">
                      {draft.check.type === "source-target-match" && (
                        <>
                          match both: <span className="font-semibold">{draft.check.pattern}</span>
                        </>
                      )}
                      {draft.check.type === "target-forbids" && (
                        <>
                          target forbids:{" "}
                          <span className="font-semibold">{draft.check.targetPattern}</span>
                        </>
                      )}
                      {draft.check.type === "source-requires-target" && (
                        <>
                          if source has{" "}
                          <span className="font-semibold">{draft.check.sourcePattern}</span>{" "}
                          → target needs{" "}
                          <span className="font-semibold">{draft.check.targetPattern}</span>
                        </>
                      )}
                    </p>
                  </div>
                  {evidence?.[i] && (
                    <p className="mt-1 text-[10px] text-muted-foreground italic">
                      From doc: {evidence[i]}
                    </p>
                  )}
                </div>
                <Button
                  variant={isAccepted ? "default" : "outline"}
                  size="sm"
                  onClick={() => toggleAccept(i)}
                  className="flex-shrink-0"
                >
                  {isAccepted ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack} className="flex-1" disabled={committing}>
          Back
        </Button>
        <Button
          onClick={handleCommit}
          disabled={accepted.size === 0 || committing}
          className="flex-1"
        >
          {committing
            ? "Adding…"
            : `Add ${accepted.size} rule${accepted.size !== 1 ? "s" : ""}`}
        </Button>
      </div>
    </div>
  )
}
