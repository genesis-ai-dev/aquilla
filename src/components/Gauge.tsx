import { cn } from "@/lib/utils"

/** Vercel-style gauge (papermark/gauge-demo), adapted for Aquilla health + validation UI. */
const VIEWBOX = 120
const RADIUS = 53
const CIRCUMFERENCE = 332 // 2 * π * 53 (matches gauge-demo)

const PRESET_PX = {
  small: 36,
  medium: 72,
  large: 144,
} as const

export type GaugePresetSize = keyof typeof PRESET_PX

function thresholdColorClass(value: number): string {
  if (value <= 33) return "text-red-500"
  if (value <= 66) return "text-amber-500"
  return "text-green-500"
}

export interface GaugeProps {
  value: number
  /** Pixel width/height. Takes precedence over `preset`. */
  sizePx?: number
  preset?: GaugePresetSize
  strokeWidth?: number
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode
  /** Show numeric value in the center when there are no children. */
  showValue?: boolean
  colorClassName?: string
  trackClassName?: string
}

export function Gauge({
  value,
  sizePx,
  preset = "small",
  strokeWidth = 2.5,
  className,
  style,
  children,
  showValue = false,
  colorClassName,
  trackClassName = "text-muted-foreground/20",
}: GaugeProps) {
  const clamped = Math.min(100, Math.max(0, value))
  const px = sizePx ?? PRESET_PX[preset]
  const valueInCircumference = (clamped / 100) * CIRCUMFERENCE
  const strokeDashoffset = CIRCUMFERENCE - valueInCircumference
  const isFull = clamped >= 100
  const showRing = clamped > 0
  const strokeVb = Math.max(2, (strokeWidth / px) * VIEWBOX)
  const fillClass = colorClassName ?? thresholdColorClass(clamped)

  const center = children ?? (
    showValue ? (
      <span className="font-bold leading-none tabular-nums opacity-0 animate-gauge_fadeIn [font-size:max(6px,0.38em)]">
        {clamped}
      </span>
    ) : null
  )

  return (
    <div
      className={cn("relative flex shrink-0 items-center justify-center", className)}
      style={{ width: px, height: px, ...style }}
    >
      {showRing && (
        <svg
          fill="none"
          shapeRendering="geometricPrecision"
          width={px}
          height={px}
          viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
          className="-rotate-90"
          aria-hidden
        >
          <circle
            className={trackClassName}
            strokeWidth={strokeVb}
            stroke="currentColor"
            fill="transparent"
            r={RADIUS}
            cx={VIEWBOX / 2}
            cy={VIEWBOX / 2}
          />
          <circle
            className={cn(!isFull && "animate-gauge_fill", fillClass)}
            strokeWidth={strokeVb}
            stroke="currentColor"
            fill="transparent"
            r={RADIUS}
            cx={VIEWBOX / 2}
            cy={VIEWBOX / 2}
            {...(isFull
              ? {}
              : {
                  strokeDasharray: `${CIRCUMFERENCE} ${CIRCUMFERENCE}`,
                  strokeLinecap: "round" as const,
                  style: {
                    strokeDashoffset,
                    transition: "stroke-dashoffset 0.5s ease, stroke 0.5s ease",
                  },
                })}
          />
        </svg>
      )}
      {center ? (
        <div className="absolute inset-0 flex items-center justify-center">{center}</div>
      ) : null}
    </div>
  )
}
