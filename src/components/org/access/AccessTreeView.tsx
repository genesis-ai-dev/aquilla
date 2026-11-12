import { MemberInspectorTrigger } from "@/components/access/MemberInspectorTrigger"
import { PlaceBreadcrumb } from "@/components/access/PlaceBreadcrumb"
import { RoleBadge } from "@/components/access/RoleBadge"
import { UserChip } from "@/components/UserChip"
import type { ScopePath } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { accessNodeId } from "./access-anchors"
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
    // The id is what an inherited role pill's link lands on (AQU-2317).
    <li
      className="min-w-0 scroll-mt-16 target:[&>div]:ring-2 target:[&>div]:ring-ring"
      id={accessNodeId(node.scope)}
      data-testid={accessNodeId(node.scope)}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-card px-3 py-2">
        {/* Every place on this page is named by the breadcrumb helper, with its
            own icon — one crumb here, since the tree already shows ancestry. */}
        <PlaceBreadcrumb path={[node.scope]} className="font-medium" />
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {node.directGrantees.length === 0 ? (
            <span className="text-muted-foreground">{t("org.access.page.noDirect")}</span>
          ) : node.directGrantees.map((g) => (
            <span key={g.userId} className="inline-flex items-center gap-1">
              <MemberInspectorTrigger userId={g.userId} username={g.displayName} from={from} herePath={here}>
                <UserChip userId={g.userId} username={g.displayName} size="xs" nameClassName="text-sm font-normal" />
              </MemberInspectorTrigger>
              {/* This view lists the grants held AT this place, so every pill here is direct. */}
              <RoleBadge roleLevel={g.roleLevel} origin={{ kind: "direct" }} />
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
