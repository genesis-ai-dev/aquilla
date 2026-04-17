import type { ProjectRecord } from "@/lib/parsers/types"
export function ReadyStep({ project: _project, onFinish }: { project: ProjectRecord; onFinish: () => void }) {
  return (
    <div>
      <button onClick={onFinish}>Finish (placeholder)</button>
    </div>
  )
}
