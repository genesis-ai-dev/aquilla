import type { ProjectRecord } from "@/lib/parsers/types"
export function ProjectStep({ displayName: _displayName, onCreated: _onCreated, onBack }: { displayName: string; onCreated: (p: ProjectRecord) => void; onBack: () => void }) {
  return (
    <div>
      <button onClick={onBack}>Back (placeholder)</button>
    </div>
  )
}
