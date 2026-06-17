// src/components/brief/BriefSection.tsx
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { TranslationBrief } from "@/lib/brief/types"
import { briefStatus } from "@/lib/brief/brief"

export interface BriefSectionProps {
  brief: TranslationBrief | undefined
  canEdit: boolean
  stale: boolean
  onEdit: () => void
  onGenerate: () => void
  /** True while an L1 generation is in flight — locks edit/generate so a
   *  concurrent open-and-save can't clobber the brief mid-regenerate. */
  busy?: boolean
}

export function BriefSection(props: BriefSectionProps) {
  const { brief, canEdit, stale, onEdit, onGenerate, busy = false } = props
  const status = briefStatus(brief)

  return (
    <section className="px-4 py-3 max-w-2xl mx-auto w-full">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold">Translation brief</h2>
        <Badge variant="secondary" className="text-[10px] capitalize">{status}</Badge>
        {brief && stale && <Badge variant="outline" className="text-[10px]">Summary out of date</Badge>}
      </div>

      {status === "none" ? (
        <div className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
          <p className="mb-3">
            Capture this project&apos;s purpose, audience, and standards so the AI drafts to your brief.
          </p>
          {canEdit && <Button size="sm" onClick={onEdit} disabled={busy}>Create brief</Button>}
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 p-4 space-y-3">
          {brief?.l1Summary ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{brief.l1Summary}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No summary generated yet.</p>
          )}
          {canEdit && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>Edit brief</Button>
              <Button size="sm" variant={stale ? "default" : "ghost"} onClick={onGenerate} disabled={busy}>
                {busy ? "Generating…" : brief?.l1Summary ? "Regenerate summary" : "Generate summary"}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
