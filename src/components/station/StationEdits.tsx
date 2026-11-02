// The Station's sound edits (AQU-2327): the Insert menu (spec item 18) and
// Save (item 8). Board 40 drew the unsaved change as a banner over the
// waveform; Sam dropped it (Nov 2): Save sits in the header beside Undo and
// Approve, and the line under the name says what isn't saved. Save saves over
// the take; its ▾ saves a new version instead. No Discard: Undo is the way
// back.

import { useRef, useState } from "react"
import { ChevronDown, Library, Mic, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { isApplePlatform } from "@/lib/platform"
import { STATION_PICKS } from "@/lib/station/picks"
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
      {/* Q3: hidden until the Library exists (AQU-2333). */}
      {STATION_PICKS.library ? (
        <button type="button" className={row} aria-expanded={libOpen} onClick={() => setLibOpen((o) => !o)} data-testid="station-insert-library">
          <Library className="size-3.5" />
          {t("editor.station.fromLibrary")}
        </button>
      ) : null}
      {STATION_PICKS.library && libOpen ? (
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

/** Item 8: what isn't saved yet, for the line under the name. */
export function useChangedText(): (kinds: readonly string[]) => string {
  const t = useT()
  return (kinds) =>
    kinds
      .map((k) => (k === "deleted" ? t("editor.station.kindDeleted") : k === "inserted" ? t("editor.station.kindInserted") : t("editor.station.kindNoise")))
      .join(", ")
}

/** How a save goes: over the take, or as a new version on this clip or
 *  everywhere the recording is used. */
export interface SaveHow {
  mode: "over" | "new"
  scope: "clip" | "all"
}

/** Item 8: Save, in the header (Sam, Nov 2). One click saves over the take,
 *  on every line it is used on; the ▾ beside it saves a new version instead,
 *  on this clip only or everywhere when the recording is used twice. */
export function StationSave({
  places,
  openLine,
  saving,
  onSave,
  menuOpen,
  onMenuOpen,
}: {
  /** The lines it is placed on; a new version asks where only for more than one. */
  places: readonly string[]
  openLine: string
  saving: boolean
  onSave(how: SaveHow): void
  menuOpen: boolean
  onMenuOpen(open: boolean): void
}) {
  const t = useT()
  const keys = isApplePlatform() ? "⌘S" : "Ctrl+S"
  const cls = "text-[12.5px] font-medium"
  return (
    <span className="inline-flex">
      <AppTooltip content={t("editor.station.saveTip", { keys })}>
        <Button
          type="button"
          size="sm"
          data-testid="station-save"
          disabled={saving}
          onClick={() => onSave({ mode: "over", scope: "all" })}
          className={`${cls} rounded-e-none`}
        >
          {saving ? t("editor.station.saving") : t("editor.station.save")}
        </Button>
      </AppTooltip>
      <DropdownMenu open={menuOpen} onOpenChange={(o) => onMenuOpen(o)}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              data-testid="station-save-more"
              aria-label={t("editor.station.saveMenu")}
              title={t("editor.station.saveMenu")}
              disabled={saving}
              className="rounded-s-none border-s border-primary-foreground/25 px-1.5"
            >
              <ChevronDown className="size-3.5" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-auto min-w-[230px]">
          <DropdownMenuItem onClick={() => onSave({ mode: "over", scope: "all" })} data-testid="station-save-over">
            {t("editor.station.saveOver")}
            <DropdownMenuShortcut>{keys}</DropdownMenuShortcut>
          </DropdownMenuItem>
          {places.length > 1 ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("editor.station.saveNew")}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onSave({ mode: "new", scope: "clip" })} data-testid="station-scope-clip" className="ps-4">
                {t("editor.station.clipOnly")}
                <span className="text-muted-foreground"> · {openLine}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSave({ mode: "new", scope: "all" })} data-testid="station-scope-all" className="ps-4">
                {t("editor.station.everywhere")}
                <span className="text-muted-foreground"> · {t("editor.station.placesCount", { count: places.length })}</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          ) : (
            <DropdownMenuItem onClick={() => onSave({ mode: "new", scope: "clip" })} data-testid="station-save-new">
              {t("editor.station.saveNew")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
