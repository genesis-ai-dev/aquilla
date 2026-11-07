import { useState } from "react"
import { MessageSquare, MessageSquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ParatextNote } from "@/lib/paratext-bridge/notes"

interface Props {
  unitId: string
  notes: ParatextNote[]
  /** False when Aquilla does not know the registered Paratext user. */
  canAdd: boolean
  onAdd: (text: string) => Promise<boolean>
}

/** Toggle + panel under one unit: the user's existing Paratext notes on that
 *  verse and a box to add one. Adding writes straight into the Paratext
 *  project; there is no pending state for notes. */
export function ParatextUnitNotes({ unitId, notes, canAdd, onAdd }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      if (await onAdd(draft)) setDraft("")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={"h-8 px-2 " + (notes.length > 0 ? "text-primary" : "text-muted-foreground")}
        aria-label={t("paratextBridge.notes.toggle")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid={`paratext-notes-toggle-${unitId}`}
      >
        {notes.length > 0 ? <MessageSquare /> : <MessageSquarePlus />}
        {notes.length > 0 ? <span className="text-xs">{notes.length}</span> : null}
      </Button>
      {open ? (
        <div className="col-span-full ms-16 mb-2 space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid={`paratext-notes-${unitId}`}>
          {notes.length === 0 ? (
            <p className="text-muted-foreground">{t("paratextBridge.notes.none")}</p>
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.thread} className="space-y-0.5">
                  <div className="text-xs text-muted-foreground">
                    {n.user} · {formatDate(n.date)}{n.status ? ` · ${n.status}` : ""}
                  </div>
                  {n.selectedText ? <div className="text-xs italic text-muted-foreground">“{n.selectedText}”</div> : null}
                  <div className="whitespace-pre-wrap">{n.text}</div>
                </li>
              ))}
            </ul>
          )}
          {canAdd ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={draft}
                rows={2}
                placeholder={t("paratextBridge.notes.placeholder")}
                onChange={(e) => setDraft(e.target.value)}
                disabled={busy}
                data-testid={`paratext-note-draft-${unitId}`}
              />
              <div>
                <Button size="sm" onClick={() => void submit()} disabled={busy || !draft.trim()} data-testid={`paratext-note-add-${unitId}`}>
                  {busy ? <Spinner /> : <MessageSquarePlus />}
                  {busy ? t("paratextBridge.notes.adding") : t("paratextBridge.notes.add")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
