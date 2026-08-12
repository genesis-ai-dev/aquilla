// The per-cell voice picker (extracted from CellVoicePanel in round 6 so the
// timeline's source cards can reuse it — SUB-38). Two layers:
//   - VoicePickerContent: the searchable cast list (+ optional footer), for
//     embedding in any popover.
//   - VoiceCombobox: the audio-lens trigger (full-width button) + popover.

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, ChevronsUpDown, Search } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import type { Voice } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"

export function VoicePickerContent({
  voices,
  activeId,
  busy,
  onPick,
  footer,
}: {
  voices: Voice[]
  activeId: string | undefined
  busy?: boolean
  onPick: (voiceId: string) => void
  /** Optional extra row under the list (e.g. "apply to all speaker lines"). */
  footer?: ReactNode
}) {
  const t = useT()
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? voices.filter((v) => v.name.toLowerCase().includes(q)) : voices
  }, [voices, query])
  return (
    <>
      <InputGroup className="mb-1.5">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          type="text"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("audio.library.searchPlaceholder")}
        />
      </InputGroup>
      <div className="max-h-56 space-y-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs italic text-muted-foreground">{t("common.noMatches")}</p>
        ) : (
          filtered.map((v) => (
            <button
              key={v.id}
              type="button"
              disabled={busy}
              onClick={() => onPick(v.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent/50 disabled:opacity-60"
            >
              <VoiceAvatar voice={v} size={20} />
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              {v.id === activeId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          ))
        )}
      </div>
      {footer}
    </>
  )
}

/** The cast combobox: a single trigger showing the active voice that opens a
 *  searchable list of the whole cast. Picking one (re)voices the line instantly
 *  — same one-click action as before, just collapsed so a large cast (60+
 *  voices) stays usable. The active voice spins while voicing. */
export function VoiceCombobox({
  voices,
  active,
  busy,
  onPick,
}: {
  voices: Voice[]
  active: Voice
  busy: boolean
  onPick: (voiceId: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Forget the search between openings so the next open starts on the full
  // cast (VoicePickerContent remounts when the popover content does).
  useEffect(() => {
    /* state lives in VoicePickerContent; remount on open resets it */
  }, [open])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* MERGE 2026-08-04: dev's tooltip sweep (5b9f9664) converted this
          trigger's title= to AppTooltip — but it edited the OLD copy of this
          component inside CellVoicePanel, which the branch had already moved
          here. Hand-ported so the change isn't silently lost. */}
      <AppTooltip content={t("editor.voice.choose")}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              aria-label={t("editor.voice.activeVoice", { name: active.name })}
              className="w-full justify-start gap-1.5"
            />
          }
        >
          <span className="relative shrink-0">
            <VoiceAvatar voice={active} size={18} />
            {busy && (
              <span className="absolute inset-0 grid place-items-center rounded-full bg-background/75">
                <Spinner className="h-3 w-3" />
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-start font-medium text-foreground">{active.name}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent align="start" side="top" className="w-60 p-2">
        <VoicePickerContent
          voices={voices}
          activeId={active.id}
          busy={busy}
          onPick={(voiceId) => {
            onPick(voiceId)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
