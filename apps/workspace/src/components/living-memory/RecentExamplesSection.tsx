import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { RecentExample } from "./recent-examples"

interface Props {
  examples: RecentExample[]
}

function formatTimestamp(iso: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString()
}

export function RecentExamplesSection({ examples }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent examples</CardTitle>
        <p className="text-sm text-muted-foreground">
          The human-validated translations Codex is drawing from right now.
        </p>
      </CardHeader>
      <CardContent>
        {examples.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No validated translations yet. Validate a cell in the editor and
            it will appear here.
          </p>
        ) : (
          <ul className="space-y-4">
            {examples.map((ex) => (
              <li key={ex.cellId} className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {ex.author && `validated by ${ex.author}`}
                  {ex.author && ex.validatedAt && " · "}
                  {formatTimestamp(ex.validatedAt)}
                </div>
                <div className="text-sm">{ex.source}</div>
                <div className="text-sm text-muted-foreground">{ex.target}</div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
