import { Suspense, lazy } from "react"
import { Routes, Route } from "react-router-dom"
import { hasAuthHintCookie } from "@/lib/frontier/session-store"
import { OrgHome } from "@/components/org/OrgHome"
import { ProjectsList } from "@/components/org/ProjectsList"
import { ArchivedProjects } from "@/components/org/ArchivedProjects"
import { ProjectOverview } from "@/components/org/ProjectOverview"
import { AssignedToMe } from "@/components/org/AssignedToMe"
import { JoinPage } from "@/components/JoinPage"
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"
import { DevLoginRoute } from "@/components/DevLoginRoute"
import { DevLogoutRoute } from "@/components/DevLogoutRoute"
import { Preferences } from "@/pages/Preferences"
import { SyncingProvider, useSyncing } from "@/context/SyncingContext"
import { OrgProvider } from "@/context/OrgContext"
import { OutboxProvider } from "@/context/OutboxContext"
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
// FRO-254: CommentsPage / LivingMemoryPage / TerminologyPage are now rendered
// inside ProjectWorkspace shell (lazy-imported there). The routes below all
// point to ProjectWorkspace; the shell detects the path suffix and swaps only
// the main content area. These top-level lazy imports are intentionally removed.
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
const AdminConsole = lazy(() =>
  import("@/pages/AdminConsole").then((m) => ({ default: m.AdminConsole })),
)
const DebugView = lazy(() =>
  import("@/components/DebugView").then((m) => ({ default: m.DebugView })),
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

/**
 * Root-path guard: visitors without the aq_hint=1 cookie are sent to
 * /homepage (the marketing page). Returning/authenticated users who have
 * the cookie proceed to OrgHome as before.
 *
 * This is a client-side defence-in-depth layer. The aquilla-web Worker
 * already does the same check at the edge (worker/index.ts) — this guard
 * only fires if the SPA is somehow reached without the Worker (e.g. local
 * dev without `wrangler dev`, or a Worker not yet deployed).
 *
 * Loop-safety: /homepage is served as homepage.html (a separate entry point
 * that never mounts this component), so this redirect can never loop back.
 */
function RootRedirect() {
  // A user who has completed onboarding is a real user of the app (they may be
  // working with local-only projects without a Frontier account), so don't
  // bounce them to the marketing homepage — only un-onboarded, signed-out
  // visitors get sent there.
  const onboarded = localStorage.getItem("codex:onboardingComplete") === "true"
  if (!hasAuthHintCookie() && !onboarded) {
    // Hard redirect so the Worker (or server) can serve homepage.html.
    // A client-side <Navigate> would stay inside the SPA bundle and find
    // no React Router match for /homepage.
    window.location.replace("/homepage")
    return null
  }
  return <OrgHome />
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
        <OutboxProvider>
          <AppRoutes />
        </OutboxProvider>
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
        <Route path="/" element={<RootRedirect />} />
        <Route path="/projects" element={<ProjectsList />} />
        <Route path="/projects/:id" element={<ProjectOverview />} />
        <Route path="/assigned" element={<AssignedToMe />} />
        <Route path="/join/:token" element={<JoinPage />} />
        <Route path="/onboarding" element={<OnboardingWizard />} />
        {/* Dev-only auto-login/logout — see components/DevLoginRoute.tsx */}
        <Route path="/__dev/login" element={<DevLoginRoute />} />
        <Route path="/__dev/logout" element={<DevLogoutRoute />} />

        {/* Lazy — org-level pages */}
        <Route path="/projects/archived" element={<ArchivedProjects />} />
        <Route path="/preferences" element={<Preferences />} />

        {/* Lazy — heavy workspace tree (pulls in tiptap, editor deps, react-player) */}
        <Route path="/project/:id" element={<ProjectWorkspace />} />
        <Route path="/project/:id/file/:fileId" element={<ProjectWorkspace />} />
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        {/* FRO-194: /rules deep-link renders inside ProjectWorkspace shell — shell stays mounted. */}
        <Route path="/project/:id/rules" element={<ProjectWorkspace />} />
        {/* ISSUE-3 fix: /voice deep-link — workspace detects suffix and activates audio lens. */}
        <Route path="/project/:id/voice" element={<ProjectWorkspace />} />
        {/* FRO-254: terminology/comments/memory now render inside the ProjectWorkspace shell
            (fixed sidebar + top bar + bottom status bar). The shell detects the path suffix
            and swaps only the main content area, same pattern as /rules. */}
        <Route path="/project/:id/terminology" element={<ProjectWorkspace />} />
        <Route path="/project/:id/comments" element={<ProjectWorkspace />} />
        <Route path="/project/:id/memory" element={<ProjectWorkspace />} />

        {/* Lazy — org admin pages */}
        <Route path="/settings" element={<Settings />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/teams" element={<TeamsList />} />
        <Route path="/teams/:groupId" element={<TeamDetail />} />

        {/* Lazy — site-wide admin console (platform operators only; gated
            client-side by usePlatformAdmin and server-side by PLATFORM_ADMINS) */}
        <Route path="/admin" element={<AdminConsole />} />

        {/* Lazy — debug views (dev/staging only) */}
        <Route path="/debug" element={<DebugView />} />
        <Route path="/project/:id/debug" element={<DebugView />} />
        <Route path="/project/:id/settings/debug" element={<DebugView />} />
        <Route path="/project/:id/comments/debug" element={<DebugView />} />
      </Routes>
    </Suspense>
  )
}
