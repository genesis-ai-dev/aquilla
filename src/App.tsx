import { Routes, Route } from "react-router-dom"
import { OrgHome } from "@/components/org/OrgHome"
import { ProjectsList } from "@/components/org/ProjectsList"
import { ArchivedProjects } from "@/components/org/ArchivedProjects"
import { TeamsList } from "@/components/org/TeamsList"
import { TeamDetail } from "@/components/org/TeamDetail"
import { ProjectOverview } from "@/components/org/ProjectOverview"
import { ProjectWorkspace } from "@/components/ProjectWorkspace"
import { ProjectSettings } from "@/components/ProjectSettings"
import { DebugView } from "@/components/DebugView"
import { RulesPage } from "@/components/RulesPage"
import { CommentsPage } from "@/components/CommentsPage"
import { JoinPage } from "@/components/JoinPage"
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"
import { DevLoginRoute } from "@/components/DevLoginRoute"
import { MembersPage } from "@/pages/MembersPage"
import { Settings } from "@/pages/Settings"
import { Preferences } from "@/pages/Preferences"
import { SyncingProvider, useSyncing } from "@/context/SyncingContext"
import { OrgProvider } from "@/context/OrgContext"
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
      <OrgProvider>
        <AppRoutes />
      </OrgProvider>
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
      <Route path="/" element={<OrgHome />} />
      <Route path="/projects" element={<ProjectsList />} />
      <Route path="/projects/archived" element={<ArchivedProjects />} />
      <Route path="/projects/:id" element={<ProjectOverview />} />
      <Route path="/debug" element={<DebugView />} />
      <Route path="/project/:id" element={<ProjectWorkspace />} />
      <Route path="/project/:id/file/:fileId" element={<ProjectWorkspace />} />
      <Route path="/project/:id/debug" element={<DebugView />} />
      <Route path="/project/:id/settings" element={<ProjectSettings />} />
      <Route path="/project/:id/settings/debug" element={<DebugView />} />
      <Route path="/project/:id/rules" element={<RulesPage />} />
      <Route path="/project/:id/comments" element={<CommentsPage />} />
      <Route path="/project/:id/comments/debug" element={<DebugView />} />
      <Route path="/join/:token" element={<JoinPage />} />
      <Route path="/onboarding" element={<OnboardingWizard />} />
      {/* Dev-only auto-login — see components/DevLoginRoute.tsx */}
      <Route path="/__dev/login" element={<DevLoginRoute />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/preferences" element={<Preferences />} />
      <Route path="/members" element={<MembersPage />} />
      <Route path="/teams" element={<TeamsList />} />
      <Route path="/teams/:groupId" element={<TeamDetail />} />
    </Routes>
  )
}
