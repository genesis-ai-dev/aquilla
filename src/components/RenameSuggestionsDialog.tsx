import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { RenameSuggestion } from "@/lib/file-labeling/detect"

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  suggestions: RenameSuggestion[]
  onApply: (chosen: RenameSuggestion[]) => void
}

export function RenameSuggestionsDialog({ open, onOpenChange, suggestions, onApply }: Props) {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (open) setChecked(new Set(suggestions.map((s) => s.fileId)))
  }, [open, suggestions])

  function toggle(id: string) {
    setChecked((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const chosen = suggestions.filter((s) => checked.has(s.fileId))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Review suggested names</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-80">
          <ul className="space-y-1 py-2">
            {suggestions.map((s) => (
              <li key={s.fileId} className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-accent">
                <Checkbox
                  checked={checked.has(s.fileId)}
                  onCheckedChange={() => toggle(s.fileId)}
                  className="mt-1"
                />
                <div className="flex-1 text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="line-through text-muted-foreground">{s.currentName}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium">{s.suggestedName}</span>
                  </div>
                  {s.suggestedCorpus && (
                    <div className="text-xs text-muted-foreground">
                      Corpus: {s.currentCorpus ?? "—"} → {s.suggestedCorpus}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={chosen.length === 0}
            onClick={() => { onApply(chosen); onOpenChange(false) }}
          >
            Apply {chosen.length} change{chosen.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
