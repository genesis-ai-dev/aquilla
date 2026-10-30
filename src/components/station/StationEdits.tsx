// The Station's sound edits (AQU-2327): the Insert menu (spec item 18) and
// the unsaved-change notice with "Save as new version" (item 8), as board 40
// draws them — the notice in its "polished in place" form (Oct 25): the
// label on the left, the two choices stacked when the recording is placed
// more than once, Save on the right. No Discard: Undo is the way back.

import { useRef, useState } from "react"
import { Library, Mic, TriangleAlert, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useT } from "@/lib/i18n/I18nProvider"
import { isApplePlatform } from "@/lib/platform"
import type { EditOp } from "@/lib/station/edit-list"

export interface InsertChoice {
  /** The draft source's id (a stored object's key). */
  id: string
  label: string
  durationSec: number | null
  url: string
  fileId: string
}

/** Item 18. */
export function StationInsertMenu({
  choices,
  onPick,
  onFile,
  onRecord,
  recordNote,
}: {
  choices: readonly InsertChoice[]
  onPick(c: InsertChoice): void
  onFile(file: File): void
  /** Absent: Record now is greyed, with `recordNote` under it. */
  onRecord?: () => void
  recordNote?: string
}) {
  const t = useT()
  const [libOpen, setLibOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const row = "flex h-7 w-full items-center gap-2 rounded-sm px-2 text-start text-[12.5px] text-foreground hover:bg-accent disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
  return (
    <div
      data-testid="station-insert-menu"
      className="flex w-[250px] flex-col rounded-md bg-popover p-1 shadow-md ring-1 ring-border"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" className={row} aria-expanded={libOpen} onClick={() => setLibOpen((o) => !o)} data-testid="station-insert-library">
        <Library className="size-3.5" />
        {t("editor.station.fromLibrary")}
      </button>
      {libOpen ? (
        <div className="flex max-h-48 flex-col overflow-y-auto pb-1 ps-[30px]">
          {choices.length === 0 ? <span className="px-1.5 py-1 text-xs text-muted-foreground">{t("editor.station.libraryEmpty")}</span> : null}
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c)}
              className="flex h-[26px] items-center gap-2 rounded-sm px-1.5 text-start text-xs text-foreground hover:bg-accent"
            >
              <span className="min-w-0 truncate">{c.label}</span>
              {c.durationSec != null ? (
                <span className="ms-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/70">{c.durationSec.toFixed(1)} s</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" className={row} onClick={() => fileRef.current?.click()} data-testid="station-insert-file">
        <Upload className="size-3.5" />
        {t("editor.station.fromFile")}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ""
          if (f) onFile(f)
        }}
      />
      <button type="button" className={row} onClick={onRecord} disabled={!onRecord} data-testid="station-insert-record">
        <Mic className="size-3.5" />
        {t("editor.station.recordNow")}
      </button>
      {!onRecord && recordNote ? <span className="px-2 pb-1 text-[11px] text-muted-foreground/70">{recordNote}</span> : null}
    </div>
  )
}

/** What changed, each kind once ("a part deleted, audio inserted"). */
export function changedKinds(ops: readonly EditOp[], extra: readonly string[] = []): string[] {
  const out: string[] = []
  for (const op of ops) {
    const k = op.kind === "del" ? "deleted" : "inserted"
    if (!out.includes(k)) out.push(k)
  }
  for (const k of extra) if (!out.includes(k)) out.push(k)
  return out
}

/** Item 8. */
export function StationNotice({
  kinds,
  places,
  scope,
  onScope,
  openLine,
  saving,
  onSave,
}: {
  kinds: readonly string[]
  /** The lines it is placed on; the choice shows only for more than one. */
  places: readonly string[]
  scope: "clip" | "all"
  onScope(s: "clip" | "all"): void
  openLine: string
  saving: boolean
  onSave(): void
}) {
  const t = useT()
  const what = kinds
    .map((k) => (k === "deleted" ? t("editor.station.kindDeleted") : k === "inserted" ? t("editor.station.kindInserted") : t("editor.station.kindNoise")))
    .join(", ")
  const many = places.length > 1
  return (
    <div
      data-testid="station-notice"
      className="mx-3 flex shrink-0 flex-wrap items-start gap-x-4 gap-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
    >
      <span className="inline-flex h-6 shrink-0 items-center gap-1.5 text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-[13px]" aria-hidden />
        <span className="text-[12.5px] font-semibold whitespace-nowrap">{t("editor.station.changed", { what })}</span>
      </span>
      {many ? (
        <RadioGroup
          aria-label={t("editor.station.applyTo")}
          value={scope}
          onValueChange={(v) => onScope(v as "clip" | "all")}
          className="flex w-auto flex-col items-start gap-2"
        >
          <label className="flex h-6 cursor-pointer items-center gap-2 whitespace-nowrap">
            <RadioGroupItem value="clip" data-testid="station-scope-clip" />
            <span className="text-[12.5px] font-medium text-foreground">
              {t("editor.station.clipOnly")}
              <span className="font-normal text-muted-foreground"> · {openLine}</span>
            </span>
          </label>
          <label className="flex h-6 cursor-pointer items-center gap-2 whitespace-nowrap">
            <RadioGroupItem value="all" data-testid="station-scope-all" />
            <span className="text-[12.5px] font-medium text-foreground">
              {t("editor.station.everywhere")}
              <span className="font-normal text-muted-foreground"> · {t("editor.station.placesCount", { count: places.length })}</span>
            </span>
          </label>
        </RadioGroup>
      ) : null}
      <Button
        type="button"
        size="sm"
        data-testid="station-save"
        title={t("editor.station.saveTip", { keys: isApplePlatform() ? "⌘S" : "Ctrl+S" })}
        disabled={saving}
        onClick={onSave}
        className="ms-auto self-center text-[12.5px] font-semibold"
      >
        {saving ? t("editor.station.saving") : t("editor.station.save")}
      </Button>
    </div>
  )
}

