import { Link } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { groupRulesByType } from "./group-rules"
import type { TranslationRule } from "@/lib/parsers/types"

interface Props {
  projectId: string
  rules: TranslationRule[]
}

function RuleList({ title, rules }: { title: string; rules: TranslationRule[] }) {
  if (rules.length === 0) return null
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">{title} ({rules.length})</h4>
      <ul className="space-y-1">
        {rules.map((r) => (
          <li key={r.id} className="text-sm text-muted-foreground">
            • {r.name}
            <span className="ml-2 rounded bg-muted px-1.5 text-xs">
              {r.severity}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function StandardsSection({ projectId, rules }: Props) {
  const groups = groupRulesByType(rules)
  const empty =
    groups.mustPreserve.length === 0 &&
    groups.mustInclude.length === 0 &&
    groups.mustNotContain.length === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Standards</CardTitle>
        <p className="text-sm text-muted-foreground">
          Rules this project has accumulated. Codex follows these and checks
          translations against them.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {empty ? (
          <p className="text-sm text-muted-foreground">
            No standards yet. Create rules to teach Codex what to preserve,
            require, or avoid.
          </p>
        ) : (
          <div className="space-y-3">
            <RuleList title="Must preserve" rules={groups.mustPreserve} />
            <RuleList title="Target must include when source matches" rules={groups.mustInclude} />
            <RuleList title="Must not contain" rules={groups.mustNotContain} />
          </div>
        )}
        <Link
          to={`/project/${projectId}/rules`}
          className="text-sm text-primary hover:underline"
        >
          Manage in Rules →
        </Link>
      </CardContent>
    </Card>
  )
}
