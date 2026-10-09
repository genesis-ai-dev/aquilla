import type { CellIssueLine } from "@/lib/rules/cell-issue-summary"

/** Check name plus the plain-language reason, one check per line. */
export function CellIssueLines({ lines }: { lines: readonly CellIssueLine[] }) {
  return (
    <div className="space-y-1 text-start">
      {lines.map((line) => (
        <p key={line.ruleId}>
          <span className="font-medium">{line.name}</span>
          {` — ${line.reason}`}
        </p>
      ))}
    </div>
  )
}
