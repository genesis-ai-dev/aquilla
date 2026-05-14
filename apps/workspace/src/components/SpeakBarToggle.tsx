// Header toggle that opts into the persistent TTS bar above the editor.
// Off by default per project; persists per-project so users who never
// generate voice on a given project don't carry the bar around.

import { Megaphone, MegaphoneOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface Props {
  enabled: boolean
  onToggle: () => void
}

export function SpeakBarToggle({ enabled, onToggle }: Props) {
  return (
    <Button
      type="button"
      size="sm"
      variant={enabled ? "secondary" : "ghost"}
      onClick={onToggle}
      className={cn("h-7 gap-1 px-2 text-[11px] font-medium")}
      title={enabled ? "Hide the Speak (TTS) bar" : "Show the Speak (TTS) bar above the editor"}
      aria-pressed={enabled}
    >
      {enabled
        ? <Megaphone className="h-3.5 w-3.5" />
        : <MegaphoneOff className="h-3.5 w-3.5" />}
      Speak
    </Button>
  )
}
