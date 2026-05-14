// Workspace SPA route table.
//
// Phase 3c (AD-11) extracted the following routes into their own discrete
// apps; this file no longer registers them:
//
//   /                        → apps/projects/        (Dashboard, ProjectList)
//   /project/:id/settings    → apps/projects/:id/settings
//   /join/:token             → apps/projects/join/:token
//   /onboarding              → apps/projects/onboarding
//   /settings                → apps/billing/         (user-billing surface)
//   /members                 → apps/org/members
//
// Cross-app navigation is a hard URL transition (apps may not import each
// other at runtime; see AD-11 navigation handoff contract). When you need
// the user back on a project's continuous-state workspace, link directly to
// `/project/:id` here or `/w/:id` after Phase 4's workspace mount rename.
//
// The workspace SPA owns continuous translation state — these routes stay
// here until Phase 3a fully relocates the workspace into apps/workspace/:
//
//   /project/:id, /project/:id/file/:fileId
//   /project/:id/{rules, memory, comments, snapshots, debug}
//   /project/:id/settings/debug
//   /debug
//
// Legacy redirect retained for backwards compatibility:
//
//   /settings/org  → /org/members  (was /members)

import { Routes, Route } from "react-router-dom"
import { ProjectWorkspace } from "@/components/ProjectWorkspace"
import { DebugView } from "@/components/DebugView"
import { RulesPage } from "@/components/RulesPage"
import { LivingMemoryPage } from "@/components/LivingMemoryPage"
import { CommentsPage } from "@/components/CommentsPage"
import { SnapshotsPage } from "@/components/SnapshotsPage"
import { SyncingProvider, useSyncing } from "@/context/SyncingContext"
import { AiModelConsentDialog } from "@/components/AiModelConsentDialog"
import { AiModelDownloadChip } from "@/components/AiModelDownloadChip"
import { AudioBulkProgressBanner } from "@/components/AudioBulkProgressBanner"
import { PrivateModeBanner } from "@/components/PrivateModeBanner"
import { hydratePrefetchStatus } from "@/lib/audio/prefetch"
import { probeOpfsAvailability } from "@/lib/storage/opfs-availability"
import { useGlobalAudioShortcuts } from "@/hooks/useGlobalAudioShortcuts"

void hydratePrefetchStatus()
void probeOpfsAvailability()

function GlobalAudioShortcuts() {
  useGlobalAudioShortcuts()
  return null
}

function SyncFreezeOverlay() {
  const { syncing } = useSyncing()
  if (!syncing) return null
  return (
    <div className="fixed top-0 left-0 right-0 z-30 bg-amber-50 text-amber-800 border-b border-amber-200 px-3 py-1 text-xs text-center">
      Merging incoming changes…
    </div>
  )
}

export default function App() {
  return (
    <SyncingProvider>
      <PrivateModeBanner />
      <SyncFreezeOverlay />
      <AppRoutes />
      <AiModelConsentDialog />
      <AiModelDownloadChip />
      <AudioBulkProgressBanner />
      <GlobalAudioShortcuts />
    </SyncingProvider>
  )
}

/** Cross-app hard navigation helper. Returns a tiny component that bounces
 *  to another app's URL. We don't use react-router's <Navigate /> because
 *  the target is in a different deployable; the browser must do a real
 *  GET so Workers Routes can dispatch. */
function HardRedirect({ to }: { to: string }) {
  if (typeof window !== "undefined") {
    window.location.replace(to)
  }
  return null
}

function AppRoutes() {
  return (
    <Routes>
      {/* Workspace surfaces — kept here until Phase 3a relocates them. */}
      <Route path="/debug" element={<DebugView />} />
      <Route path="/project/:id" element={<ProjectWorkspace />} />
      <Route path="/project/:id/file/:fileId" element={<ProjectWorkspace />} />
      <Route path="/project/:id/debug" element={<DebugView />} />
      <Route path="/project/:id/settings/debug" element={<DebugView />} />
      <Route path="/project/:id/rules" element={<RulesPage />} />
      <Route path="/project/:id/memory" element={<LivingMemoryPage />} />
      <Route path="/project/:id/comments" element={<CommentsPage />} />
      <Route path="/project/:id/comments/debug" element={<DebugView />} />
      <Route path="/project/:id/snapshots" element={<SnapshotsPage />} />
      <Route path="/project/:id/snapshots/debug" element={<DebugView />} />

      {/* Backwards-compat redirects to relocated apps. /settings/org used to
          point inside this SPA; the operational members surface now lives in
          apps/org/. A hard navigation is required since /org is a different
          Worker deploy (no in-router resolution possible). */}
      <Route path="/settings/org" element={<HardRedirect to="/org/members" />} />
    </Routes>
  )
}
