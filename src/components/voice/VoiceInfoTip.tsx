import { Info } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"

/** Circled-i next to a field label. Hover/focus shows `content`. */
export function VoiceInfoTip({
  content,
  label,
}: {
  content: string
  label: string
}) {
  return (
    <AppTooltip content={content} side="top">
      <button
        type="button"
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        aria-label={label}
      >
        <Info className="size-3.5" aria-hidden />
      </button>
    </AppTooltip>
  )
}
