import { useState } from "react"
import { Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { RenameSuggestion } from "@/lib/file-labeling/detect"
import { RenameSuggestionsDialog } from "./RenameSuggestionsDialog"

interface Props {
  suggestions: RenameSuggestion[]
  onApply: (chosen: RenameSuggestion[]) => void
  onDismiss: () => void
}

export function SuggestionBanner({ suggestions, onApply, onDismiss }: Props) {
  const [reviewOpen, setReviewOpen] = useState(false)
  if (suggestions.length === 0) return null
  const bibleCount = suggestions.filter((s) => s.source === "bible-book").length
  const seCount = suggestions.filter((s) => s.source === "season-episode").length
  const parts: string[] = []
  if (bibleCount > 0) parts.push(`${bibleCount} Bible book${bibleCount === 1 ? "" : "s"}`)
  if (seCount > 0) parts.push(`${seCount} episode${seCount === 1 ? "" : "s"}`)
  const family = suggestions.length - bibleCount - seCount
  if (family > 0) parts.push(`${family} numbered file${family === 1 ? "" : "s"}`)
  const label = parts.join(", ")

  return (
    <>
      <div className="mx-2 mt-2 mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800/40 dark:bg-amber-950/30 dark:text-amber-300">
        <div className="flex items-start gap-1.5">
          <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">{label} — apply friendly names?</p>
            <div className="mt-1.5 flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>Review</Button>
              <Button size="sm" onClick={() => onApply(suggestions)}>Apply all</Button>
            </div>
          </div>
          <button
            className="p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <RenameSuggestionsDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        suggestions={suggestions}
        onApply={onApply}
      />
    </>
  )
}
