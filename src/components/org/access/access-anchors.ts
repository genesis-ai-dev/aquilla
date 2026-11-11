import type { ScopeRef } from "@/lib/access/types"

/**
 * AQU-2317: the DOM id of a place's node in the Access page's scope tree. An
 * inherited role pill links here, so the reader lands on the grant it comes
 * from instead of being told a path and left to find it.
 */
export function accessNodeId(scope: Pick<ScopeRef, "type" | "id">): string {
  return `access-node-${scope.type}-${scope.id}`
}

/** In-page link to that node, or nothing for a place the viewer cannot see. */
export function accessNodeHref(scope: ScopeRef): string | undefined {
  return scope.hidden ? undefined : `#${accessNodeId(scope)}`
}
