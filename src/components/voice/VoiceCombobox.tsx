// The per-cell voice picker (extracted from CellVoicePanel in round 6 so the
// timeline's source cards can reuse it — SUB-38). Two layers:
//   - VoicePickerContent: the searchable cast list (+ optional footer), for
//     embedding in any popover.
//   - VoiceCombobox: the audio-lens trigger (full-width button) + popover.

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, ChevronsUpDown, Search } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import type { Voice } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { VoiceNameWithLanguage } from "@/components/voice/VoiceLanguageBadge"

/** Same row metrics as a notifications-inbox row: flush, instant hover. */
export const voicePickerRowClass =
  "flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-start text-sm outline-hidden select-none hover:bg-accent/40 focus-visible:bg-accent focus-visible:text-accent-foreground disabled:opacity-60"

export function VoicePickerContent({
  voices,
  activeId,
  busy,
  onPick,
  beforeList,
  afterList,
  footer,
  showLanguageBadge = false,
}: {
  voices: Voice[]
  activeId: string | undefined
  busy?: boolean
  onPick: (voiceId: string) => void
  /** Optional first row inside the cast list (e.g. "No character"). */
  beforeList?: ReactNode
  /** Optional last row of the cast list (e.g. "Add a voice…"), flush with the voices. */
  afterList?: ReactNode
  /** Optional block under the list (e.g. how far a cast reaches). */
  footer?: ReactNode
  showLanguageBadge?: boolean
}) {
  const t = useT()
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? voices.filter((v) => v.name.toLowerCase().includes(q)) : voices
  }, [voices, query])
  return (
    <div className="flex flex-col gap-2">
      <InputGroup>
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
      <div className="flex flex-col">
        <div className="flex max-h-56 flex-col overflow-y-auto overscroll-contain scrollbar-thin">
          {beforeList}
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs italic text-muted-foreground">{t("common.noMatches")}</p>
          ) : (
            filtered.map((v) => (
              <button
                key={v.id}
                type="button"
                disabled={busy}
                onClick={() => onPick(v.id)}
                className={voicePickerRowClass}
              >
                <VoiceAvatar voice={v} size={20} />
                <VoiceNameWithLanguage
                  name={v.name}
                  language={v.language}
                  showBadge={showLanguageBadge}
                  className="min-w-0 flex-1"
                />
                {v.id === activeId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            ))
          )}
        </div>
        {afterList}
        {footer}
      </div>
    </div>
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
  showLanguageBadge = false,
}: {
  voices: Voice[]
  active: Voice
  busy: boolean
  onPick: (voiceId: string) => void
  showLanguageBadge?: boolean
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
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="sm"
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
              <span className="absolute inset-0 grid place-items-center rounded-md bg-background/75">
                <Spinner className="h-3 w-3" />
              </span>
            )}
          </span>
          <VoiceNameWithLanguage
            name={active.name}
            language={active.language}
            showBadge={showLanguageBadge}
            className="min-w-0 flex-1 font-medium text-foreground"
          />
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-60 gap-0 overflow-hidden p-2">
        <VoicePickerContent
          voices={voices}
          activeId={active.id}
          busy={busy}
          showLanguageBadge={showLanguageBadge}
          onPick={(voiceId) => {
            onPick(voiceId)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
