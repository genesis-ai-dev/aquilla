import { Routes, Route, Navigate } from "react-router-dom"
import { Dashboard } from "@/components/Dashboard"
import { ProjectWorkspace } from "@/components/ProjectWorkspace"
import { ProjectSettings } from "@/components/ProjectSettings"
import { DebugView } from "@/components/DebugView"
import { RulesPage } from "@/components/RulesPage"
import { VoiceStudioPage } from "@/components/VoiceStudioPage"
import { CommentsPage } from "@/components/CommentsPage"
import { JoinPage } from "@/components/JoinPage"
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"
import { MembersPage } from "@/pages/MembersPage"
import { Settings } from "@/pages/Settings"
import { SyncingProvider, useSyncing } from "@/context/SyncingContext"
import { AiModelConsentDialog } from "@/components/AiModelConsentDialog"
import { AiModelDownloadChip } from "@/components/AiModelDownloadChip"
import { AudioBulkProgressBanner } from "@/components/AudioBulkProgressBanner"
import { PrivateModeBanner } from "@/components/PrivateModeBanner"
import { VersionBadge } from "@/components/VersionBadge"
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
    <div className="fixed top-0 left-0 right-0 z-40 bg-amber-50 text-amber-800 border-b border-amber-200 px-3 py-1 text-xs text-center">
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
      <VersionBadge />
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
      <Route path="/project/:id/voice" element={<VoiceStudioPage />} />
      <Route path="/project/:id/comments" element={<CommentsPage />} />
      <Route path="/project/:id/comments/debug" element={<DebugView />} />
      {/* Backward-compat: external links / bookmarks that point at /projects
          are redirected to the canonical dashboard at /.
          In dev there is no front-door Worker, so this explicit route also
          prevents the `/:id` catch-all from eating the path. */}
      <Route path="/projects" element={<Navigate to="/" replace />} />
      <Route path="/join/:token" element={<JoinPage />} />
      <Route path="/onboarding" element={<OnboardingWizard />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/members" element={<MembersPage />} />
    </Routes>
  )
}
