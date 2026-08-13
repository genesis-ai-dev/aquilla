import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import "./bar-spinner.css"

const BAR_COUNT = 10
const CYCLE_S = 1.2
const bars = Array.from({ length: BAR_COUNT })

type BarSpinnerProps = React.ComponentProps<"div"> & {
  /** When false, bars stop animating (e.g. toast handoff). */
  visible?: boolean
}

function BarSpinner({ className, visible = true, ...props }: BarSpinnerProps) {
  const t = useT()
  return (
    <div
      role="status"
      aria-label={t("common.loadingSpinner")}
      className={cn("bar-spinner size-3.5 shrink-0", className)}
      data-visible={visible}
      {...props}
    >
      <div className="bar-spinner__ring" aria-hidden>
        {bars.map((_, i) => (
          <div
            className="bar-spinner__bar"
            key={`bar-spinner-${i}`}
            style={{
              animationDelay: `${-CYCLE_S + (i * CYCLE_S) / BAR_COUNT}s`,
              transform: `rotate(${(i * 360) / BAR_COUNT}deg) translate(var(--bar-spinner-orbit))`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

export { BarSpinner }
