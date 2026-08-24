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
          className="absolute -bottom-0.5 -end-0.5 grid place-items-center rounded-full bg-emerald-500 text-white ring-1 ring-background"
          style={{ width: Math.round(size * 0.45), height: Math.round(size * 0.45) }}
        >
          <Sparkles style={{ width: Math.round(size * 0.28), height: Math.round(size * 0.28) }} />
        </span>
      )}
    </span>
  )
}

/**
 * The counterpart to `VoiceAvatar`: the slot for a line nobody has cast.
 * (AQU-646, Sam 2026-08-20)
 *
 * It used to be a faded Narrator orb inside a dotted ring, which said the wrong
 * thing twice — it showed a face for a character who does not exist, and the
 * fallback voice's identity read as a weak assignment rather than as none. Now
 * it is an empty dashed ring with "NC" in it, and the only thing it resembles
 * is a blank.
 *
 * WHY THIS IS AN SVG AND NOT `border-dashed`. CSS gives the browser complete
 * control of dash length; on a circle it lays the pattern along the path and
 * the seam falls wherever it happens to fall, so the ring closes on a
 * half-drawn dash — and differently at each zoom level and pixel density. The
 * fix is arithmetic, which means drawing the ring ourselves: choose a TARGET
 * segment length, round the circumference into a whole number of them, then
 * divide the circumference by that integer. The result is a segment very close
 * to the target that also closes exactly, at any radius — dashes stay the same
 * visual length as the circle grows instead of stretching with it.
 */
export function NoCharacterAvatar({ size = 24, className }: { size?: number; className?: string }) {
  const stroke = Math.max(1, size / 21)
  // Centred stroke: the path sits half a stroke inside the box, so the ring's
  // outer edge lands exactly on `size` and lines up with a solid avatar beside it.
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const TARGET_SEGMENT = 5
  const segments = Math.max(6, Math.round(circumference / TARGET_SEGMENT))
  const segment = circumference / segments
  const dash = segment * 0.6

  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0 select-none text-muted-foreground", className)}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.55}
        strokeWidth={stroke}
        // Butt caps on purpose. A round cap adds half a stroke-width at BOTH
        // ends of every dash, lengthening each one and putting back the seam
        // the arithmetic above just removed.
        strokeLinecap="butt"
        strokeDasharray={`${dash} ${segment - dash}`}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        fillOpacity={0.7}
        fontSize={Math.round(size * 0.34)}
        fontWeight={600}
        // The one string here is not a name or a sentence — it is a two-letter
        // mark for "no character", and it stays the same in every language.
        // i18n-exempt symbol, not prose
      >
        NC
      </text>
    </svg>
  )
}
