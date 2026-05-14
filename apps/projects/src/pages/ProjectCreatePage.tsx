// Project-create flow.
//
// Phase 3c stub. Phase 5 will populate this with a project-shape picker
// (self-contained / source-only / linked target, per AD-9). The workspace
// SPA's current src/components/ProjectCreateDialog.tsx is the source UI to
// port; the linked-target case ties into the source-linking Phase-5 panel.

import { Link } from "react-router-dom"
import { Button } from "@aquilla/ui"

export function ProjectCreatePage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Create a project</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Phase 3c scaffold. The shape picker (self-contained / source-only /
        linked target) lands with Phase 5; see AD-9.
      </p>
      <div className="mt-6">
        <Link to="/">
          <Button variant="outline">Back to projects</Button>
        </Link>
      </div>
    </div>
  )
}
