/**
 * AgentMemoryTab.tsx — SWARM-TODO(aqu-agent): PLACEHOLDER, owned by W1E.
 *
 * W1D (this file's author) only wires the Memory tab SLOT in
 * AgentWorkbench.tsx (lazy import + Suspense fallback) per
 * docs/swarm/AQU-AGENT-CONTRACTS.md §5. The real tab — proposed-memory
 * review list (approve/reject), approved list with edit, provenance
 * display, human-edited badge, BriefEditor — lands here from W1E's branch.
 * This stub exists ONLY so W1D's worktree compiles standalone; the
 * integration merge takes W1E's file, not this one.
 */

export default function AgentMemoryTab({ projectId }: { projectId: string }) {
  return (
    <div className="p-4 text-sm text-muted-foreground">
      Memory tab placeholder for project {projectId} — replaced by W1E's AgentMemoryTab.
    </div>
  )
}
