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
// `/w/:id` from another app. Local dev and the smoke suite still use the
// root-mounted `/project/:id` form.
//
// The workspace SPA owns continuous translation state — these routes stay
// here until Phase 3a fully relocates the workspace into apps/workspace/:
//
//   /project/:id, /project/:id/file/:fileId
//   /project/:id/{rules, memory, comments, snapshots, debug}
//   /project/:id/settings/debug
//   /debug
//
// Redirect retained for the settings handoff:
//
//   /settings/org  → /org/members

import { Routes, Route } from "react-router-dom"
import { Dashboard } from "@/components/Dashboard"
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

const ENABLE_SMOKE_DASHBOARD_ROUTE = import.meta.env.MODE === "test"

const workspacePaths = (suffix = "") => [
  `/project/:id${suffix}`,
  `/:id${suffix}`,
]

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

export function AppRoutes() {
  return (
    <Routes>
      {/* Vite preview does not apply public/_redirects, while the smoke suite
          drives the root dashboard. Keep this route test-only so production
          continues to hand `/` to apps/projects/. */}
      {ENABLE_SMOKE_DASHBOARD_ROUTE ? (
        <Route path="/" element={<Dashboard />} />
      ) : null}

      {/* Workspace surfaces — kept here until Phase 3a relocates them. */}
      <Route path="/debug" element={<DebugView />} />
      {workspacePaths().map((path) => (
        <Route key={path} path={path} element={<ProjectWorkspace />} />
      ))}
      {workspacePaths("/file/:fileId").map((path) => (
        <Route key={path} path={path} element={<ProjectWorkspace />} />
      ))}
      {workspacePaths("/debug").map((path) => (
        <Route key={path} path={path} element={<DebugView />} />
      ))}
      {workspacePaths("/settings/debug").map((path) => (
        <Route key={path} path={path} element={<DebugView />} />
      ))}
      {workspacePaths("/rules").map((path) => (
        <Route key={path} path={path} element={<RulesPage />} />
      ))}
      {workspacePaths("/memory").map((path) => (
        <Route key={path} path={path} element={<LivingMemoryPage />} />
      ))}
      {workspacePaths("/comments").map((path) => (
        <Route key={path} path={path} element={<CommentsPage />} />
      ))}
      {workspacePaths("/comments/debug").map((path) => (
        <Route key={path} path={path} element={<DebugView />} />
      ))}
      {workspacePaths("/snapshots").map((path) => (
        <Route key={path} path={path} element={<SnapshotsPage />} />
      ))}
      {workspacePaths("/snapshots/debug").map((path) => (
        <Route key={path} path={path} element={<DebugView />} />
      ))}

      {/* A hard navigation is required since /org is a different Worker deploy
          and cannot be resolved inside this router. */}
      <Route path="/settings/org" element={<HardRedirect to="/org/members" />} />
    </Routes>
  )
}
