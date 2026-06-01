import { Suspense, lazy } from "react"
import { Routes, Route } from "react-router-dom"
import { OrgHome } from "@/components/org/OrgHome"
import { ProjectsList } from "@/components/org/ProjectsList"
import { ArchivedProjects } from "@/components/org/ArchivedProjects"
import { ProjectOverview } from "@/components/org/ProjectOverview"
import { JoinPage } from "@/components/JoinPage"
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"
import { DevLoginRoute } from "@/components/DevLoginRoute"
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

// Heavy workspace / admin routes — loaded only when navigated to
const ProjectWorkspace = lazy(() =>
  import("@/components/ProjectWorkspace").then((m) => ({ default: m.ProjectWorkspace })),
)
const ProjectSettings = lazy(() =>
  import("@/components/ProjectSettings").then((m) => ({ default: m.ProjectSettings })),
)
const RulesPage = lazy(() =>
  import("@/components/RulesPage").then((m) => ({ default: m.RulesPage })),
)
const CommentsPage = lazy(() =>
  import("@/components/CommentsPage").then((m) => ({ default: m.CommentsPage })),
)
const LivingMemoryPage = lazy(() =>
  import("@/components/LivingMemoryPage").then((m) => ({ default: m.LivingMemoryPage })),
)
const MembersPage = lazy(() =>
  import("@/pages/MembersPage").then((m) => ({ default: m.MembersPage })),
)
const Settings = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.Settings })),
)
const TeamsList = lazy(() =>
  import("@/components/org/TeamsList").then((m) => ({ default: m.TeamsList })),
)
const TeamDetail = lazy(() =>
  import("@/components/org/TeamDetail").then((m) => ({ default: m.TeamDetail })),
)
const DebugView = lazy(() =>
  import("@/components/DebugView").then((m) => ({ default: m.DebugView })),
)
const TerminologyPage = lazy(() =>
  import("@/components/TerminologyPage").then((m) => ({ default: m.TerminologyPage })),
)

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

/** Minimal fallback used while lazy route chunks are loading. */
function RouteLoadingFallback() {
  return (
    <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
      Loading…
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
    <Suspense fallback={<RouteLoadingFallback />}>
      <Routes>
        {/* Eager — needed for first paint / sign-in flow */}
        <Route path="/" element={<OrgHome />} />
        <Route path="/projects" element={<ProjectsList />} />
        <Route path="/projects/:id" element={<ProjectOverview />} />
        <Route path="/join/:token" element={<JoinPage />} />
        <Route path="/onboarding" element={<OnboardingWizard />} />
        {/* Dev-only auto-login — see components/DevLoginRoute.tsx */}
        <Route path="/__dev/login" element={<DevLoginRoute />} />

        {/* Lazy — org-level pages */}
        <Route path="/projects/archived" element={<ArchivedProjects />} />
        <Route path="/preferences" element={<Preferences />} />

        {/* Lazy — heavy workspace tree (pulls in tiptap, editor deps, react-player) */}
        <Route path="/project/:id" element={<ProjectWorkspace />} />
        <Route path="/project/:id/file/:fileId" element={<ProjectWorkspace />} />
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/rules" element={<RulesPage />} />
        <Route path="/project/:id/terminology" element={<TerminologyPage />} />
        <Route path="/project/:id/comments" element={<CommentsPage />} />
        <Route path="/project/:id/memory" element={<LivingMemoryPage />} />

        {/* Lazy — org admin pages */}
        <Route path="/settings" element={<Settings />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/teams" element={<TeamsList />} />
        <Route path="/teams/:groupId" element={<TeamDetail />} />

        {/* Lazy — debug views (dev/staging only) */}
        <Route path="/debug" element={<DebugView />} />
        <Route path="/project/:id/debug" element={<DebugView />} />
        <Route path="/project/:id/settings/debug" element={<DebugView />} />
        <Route path="/project/:id/comments/debug" element={<DebugView />} />
      </Routes>
    </Suspense>
  )
}
