// Multi-project invite flow.
//
// Source: src/components/MultiProjectInviteDialog.tsx (Phase-2 multi-project
// invite spec). Inviter picks projects + role + recipient email; server
// mints invite tokens scoped to all selected projects in one transaction.
//
// Phase 3c stub. The dialog logic ties into useAccessibleProjects + an
// endpoint that the api-client doesn't expose yet (multi-project invites
// route lives in apps/frontier-server/src/routes/invites.ts but the client
// wrapper is in src/lib/sync/multi-project-invites.ts in the workspace SPA).
// Port that wrapper into @aquilla/api-client when relocating.

import { Link } from "react-router-dom"
import { Button } from "@aquilla/ui"

export function InvitePage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-4">
        <Link to="/">
          <Button variant="ghost" size="sm">
            ← Organization
          </Button>
        </Link>
      </div>

      <h1 className="text-2xl font-semibold">Invite to multiple projects</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Phase 3c scaffold. Multi-project invite UI ports from
        src/components/MultiProjectInviteDialog.tsx once the
        multi-project-invites wrapper is added to @aquilla/api-client.
      </p>
    </div>
  )
}
