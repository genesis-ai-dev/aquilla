import { NoteOnClick } from "@/components/ui/info-note"
import { useLiveness } from "@/hooks/useLiveness"

/**
 * The coloured "live / updating / offline" mark, with its state on click
 * (AQU-2260 — a mark, not a button, so never on hover).
 *
 * A component of its own because `useLiveness` ticks once a second to keep
 * "synced 12s ago" current (AQU-2654). Called from the page that shows the
 * mark, that tick re-rendered the whole page every second for as long as it
 * was open; here it re-renders a dot.
 *
 * `bumpedAt` is the caller's "something just changed" counter — see
 * `useLiveness`.
 */
export function LivenessDot({ bumpedAt }: { bumpedAt: number }) {
  const { state, label } = useLiveness(bumpedAt)
  return (
    <NoteOnClick note={label} label={label} className="shrink-0 p-1">
      <span
        aria-hidden
        className={[
          "h-2 w-2 shrink-0 rounded-full transition-colors",
          state === "offline"
            ? "bg-red-500"
            : state === "updating"
              ? "bg-amber-400 animate-pulse"
              : "bg-emerald-500",
        ].join(" ")}
      />
    </NoteOnClick>
  )
}
