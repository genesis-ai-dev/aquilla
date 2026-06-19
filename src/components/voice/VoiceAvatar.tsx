// The shared voice "orb": a small gradient avatar carrying a voice's color and
// initial. Used everywhere a voice shows up — the Voices panel rows, the
// per-line speaker chip, and the playback bar — so a character reads identically
// across the whole Audio lens. A voice with a clone reference gets a tiny emerald
// sparkle marker in the corner (the only visual tell of a "cloned" voice).

import { Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Voice } from "@/lib/parsers/types"

export function VoiceAvatar({
  voice,
  size = 24,
  className,
}: {
  voice: Voice | undefined
  /** Diameter in px. Font + marker scale off this. */
  size?: number
  className?: string
}) {
  const color = voice?.color || "#94a3b8"
  const initial = (voice?.name?.trim()?.[0] || "?").toUpperCase()
  const isClone = Boolean(voice?.referenceAudioId)
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid shrink-0 select-none place-items-center rounded-full font-semibold text-white shadow-sm ring-1 ring-black/10",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        backgroundImage: `linear-gradient(135deg, color-mix(in srgb, ${color} 80%, #fff), ${color} 45%, color-mix(in srgb, ${color} 55%, #000))`,
      }}
    >
      {initial}
      {isClone && (
        <span
          className="absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full bg-emerald-500 text-white ring-1 ring-background"
          style={{ width: Math.round(size * 0.45), height: Math.round(size * 0.45) }}
        >
          <Sparkles style={{ width: Math.round(size * 0.28), height: Math.round(size * 0.28) }} />
        </span>
      )}
    </span>
  )
}
