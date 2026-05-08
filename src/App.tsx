import { Routes, Route, Navigate } from "react-router-dom"
import LocalStoreDemo from "@/pages/LocalStoreDemo"
import { Dashboard } from "@/components/Dashboard"
import { ProjectWorkspace } from "@/components/ProjectWorkspace"
import { ProjectSettings } from "@/components/ProjectSettings"
import { DebugView } from "@/components/DebugView"
import { RulesPage } from "@/components/RulesPage"
import { LivingMemoryPage } from "@/components/LivingMemoryPage"
import { CommentsPage } from "@/components/CommentsPage"
import { SnapshotsPage } from "@/components/SnapshotsPage"
import { JoinPage } from "@/components/JoinPage"
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"
import { MembersPage } from "@/pages/MembersPage"
import { Settings } from "@/pages/Settings"
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
    <div className="fixed top-0 left-0 right-0 z-50 bg-amber-50 text-amber-800 border-b border-amber-200 px-3 py-1 text-xs text-center">
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

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/debug" element={<DebugView />} />
      <Route path="/project/:id" element={<ProjectWorkspace />} />
      <Route path="/project/:id/file/:fileId" element={<ProjectWorkspace />} />
      <Route path="/project/:id/debug" element={<DebugView />} />
      <Route path="/project/:id/settings" element={<ProjectSettings />} />
      <Route path="/project/:id/settings/debug" element={<DebugView />} />
      <Route path="/project/:id/rules" element={<RulesPage />} />
      <Route path="/project/:id/memory" element={<LivingMemoryPage />} />
      <Route path="/project/:id/comments" element={<CommentsPage />} />
      <Route path="/project/:id/comments/debug" element={<DebugView />} />
      <Route path="/project/:id/snapshots" element={<SnapshotsPage />} />
      <Route path="/project/:id/snapshots/debug" element={<DebugView />} />
      <Route path="/join/:token" element={<JoinPage />} />
      <Route path="/onboarding" element={<OnboardingWizard />} />
      {/* Dev-only smoke surface for the new local-store stack. See
          docs/DATA_PERSISTENCE_PLAN.md and the e2e spec at
          e2e/specs/local-store/demo.smoke.spec.ts. */}
      <Route path="/dev/local-store" element={<LocalStoreDemo />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/members" element={<MembersPage />} />
      {/* Backward-compat: the old admin-flavored URL still resolves but
          permanently redirects to the operational /members surface. */}
      <Route path="/settings/org" element={<Navigate to="/members" replace />} />
    </Routes>
  )
}
