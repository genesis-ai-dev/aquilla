import { MemberInspectorTrigger } from "@/components/access/MemberInspectorTrigger"
import { roleLabel } from "@/components/access/labels"
import type { ScopePath } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import type { AccessTreeNode } from "./org-access-data"

/** AQU-1352 §3.6: org › teams › projects, each node listing its direct grantees. */
export function AccessTreeView({ tree }: { tree: AccessTreeNode[] }) {
  return (
    <ul className="flex flex-col gap-2" data-testid="access-tree">
      {tree.map((n) => <TreeNode key={`${n.scope.type}:${n.scope.id}`} node={n} path={[]} />)}
    </ul>
  )
}

function TreeNode({ node, path }: { node: AccessTreeNode; path: ScopePath }) {
  const t = useT()
  const here = [...path, node.scope]
  const from = { type: node.scope.type as "org" | "team" | "project", id: node.scope.id }
  return (
    <li className="min-w-0" data-testid={`access-node-${node.scope.type}-${node.scope.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border bg-card px-3 py-2">
        <span className="text-xs text-muted-foreground">{t(`org.access.scope.${node.scope.type}`)}</span>
        <span className="font-medium">{node.scope.name}</span>
        <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-sm">
          {node.directGrantees.length === 0 ? (
            <span className="text-muted-foreground">{t("org.access.page.noDirect")}</span>
          ) : node.directGrantees.map((g) => (
            <span key={g.userId} className="inline-flex items-baseline gap-1">
              <MemberInspectorTrigger userId={g.userId} username={g.displayName} from={from} herePath={here}>
                {g.displayName}
              </MemberInspectorTrigger>
              <span className="text-xs text-muted-foreground">{roleLabel(t, g.roleLevel)}</span>
            </span>
          ))}
        </span>
      </div>
      {node.children.length > 0 && (
        <ul className="ms-4 mt-2 flex flex-col gap-2 border-s ps-3">
          {node.children.map((c) => <TreeNode key={`${c.scope.type}:${c.scope.id}`} node={c} path={here} />)}
        </ul>
      )}
    </li>
  )
}
