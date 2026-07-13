// Inline old→new word diff for a review-panel cell (AQU-478).

import { wordDiff } from "@/lib/text/word-diff"

export function DiffText({ oldValue, newValue }: { oldValue: string | null; newValue: string }) {
  if (oldValue == null || oldValue.trim() === "") {
    return (
      <span className="text-sm text-foreground">
        {newValue || <span className="italic text-muted-foreground">(empty)</span>}
      </span>
    )
  }
  const tokens = wordDiff(oldValue, newValue)
  return (
    <span className="text-sm leading-relaxed">
      {tokens.map((t, i) => {
        if (t.op === "equal") return <span key={i}>{t.text}</span>
        if (t.op === "delete") {
          return (
            <span
              key={i}
              className="rounded-sm bg-red-100 text-red-700 line-through dark:bg-red-950 dark:text-red-300"
            >
              {t.text}
            </span>
          )
        }
        return (
          <span
            key={i}
            className="rounded-sm bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          >
            {t.text}
          </span>
        )
      })}
    </span>
  )
}
