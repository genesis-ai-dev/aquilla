import { Suspense, lazy } from "react"
import { Navigate, Routes, Route } from "react-router-dom"
import { hasAuthHintCookie } from "@/lib/frontier/session-store"
import { OrgHome } from "@/components/org/OrgHome"
import { OrgRouteGate } from "@/components/org/OrgRouteGate"
import { ProductTourProvider } from "@/context/ProductTourContext"
import { ArchivedProjects } from "@/components/org/ArchivedProjects"
import { ProjectOverview } from "@/components/org/ProjectOverview"
import { AssignedToMe } from "@/components/org/AssignedToMe"
import { SharedProjectsPage } from "@/components/org/SharedProjectsPage"
import { resumeOrgPath } from "@/lib/navigation/org-paths"
import { JoinPage } from "@/components/JoinPage"
import { AccessLinkPage } from "@/components/AccessLinkPage"
import { JoinOrgPage } from "@/components/JoinOrgPage"
import { VerifyEmailPage } from "@/components/VerifyEmailPage"
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"
import { ResetPassword } from "@/pages/ResetPassword"
import { Login } from "@/pages/Login"
import { PrivacyPolicy } from "@/pages/PrivacyPolicy"
import { NotFound } from "@/pages/NotFound"
import { DevLoginRoute } from "@/components/DevLoginRoute"
import { DevLogoutRoute } from "@/components/DevLogoutRoute"
import { MarketingLoginRoute } from "@/components/MarketingLoginRoute"
import { Preferences } from "@/pages/Preferences"
import { SyncingProvider, useSyncing } from "@/context/SyncingContext"
import { OrgProvider } from "@/context/OrgContext"
import { OutboxProvider } from "@/context/OutboxContext"
import { NavHistoryProvider } from "@/context/NavHistoryContext"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { Spinner } from "@/components/ui/spinner"
import { AiModelConsentDialog } from "@/components/AiModelConsentDialog"
import { AiModelDownloadChip } from "@/components/AiModelDownloadChip"
import { AudioBulkProgressBanner } from "@/components/AudioBulkProgressBanner"
import { PrivateModeBanner } from "@/components/PrivateModeBanner"
import { SessionExpiredBanner } from "@/components/SessionExpiredBanner"
import { VersionBadge } from "@/components/VersionBadge"
import { UpdateBanner } from "@/components/UpdateBanner"
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
// AQU-254: CommentsPage / LivingMemoryPage / TerminologyPage are now rendered
// inside ProjectWorkspace shell (lazy-imported there). The routes below all
// point to ProjectWorkspace; the shell detects the path suffix and swaps only
// the main content area. These top-level lazy imports are intentionally removed.
const MembersPage = lazy(() =>
  import("@/pages/MembersPage").then((m) => ({ default: m.MembersPage })),
)
const Settings = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.Settings })),
)
const OrgSettingsIdentity = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsIdentity })),
)
const OrgSettingsExport = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsExport })),
)
const OrgSettingsProviders = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsProviders })),
)
const OrgSettingsMonday = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsMonday })),
)
// Monday OAuth landing — Monday's registered redirect URI is this SPA route.
const MondayOAuthCallback = lazy(() =>
  import("@/pages/settings/MondayOAuthCallback").then((m) => ({ default: m.MondayOAuthCallback })),
)
const OrgSettingsRoster = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsRoster })),
)
const OrgSettingsAssignment = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsAssignment })),
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
// Agent API (AQU-533 §3) — standalone ask-mode approval page; works without
// the workspace shell (mirrors JoinPage's standalone-page precedent).
const ApproveChangeset = lazy(() =>
  import("@/pages/ApproveChangeset/ApproveChangeset").then((m) => ({ default: m.ApproveChangeset })),
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
 * Root-path guard: unsigned visitors → marketing homepage; signed-in users
 * resume the last org (`/orgs/$id` or `/orgs/all` from localStorage).
 *
 * Client-side defence-in-depth — the aquilla-web Worker does the same cookie
 * check at the edge. Loop-safe: /homepage is a separate entry (homepage.html).
 */
function RootRedirect() {
  const onboarded = localStorage.getItem("codex:onboardingComplete") === "true"
  if (!hasAuthHintCookie() && !onboarded) {
    window.location.replace("/homepage")
    return null
  }
  return <Navigate to={resumeOrgPath()} replace />
}

/** Fallback used while lazy route chunks are loading (e.g. the workspace). */
function RouteLoadingFallback() {
  return (
    <div className="flex h-screen items-center justify-center text-muted-foreground">
      <Spinner />
    </div>
  )
}

export default function App() {
  return (
    // Single app-wide tooltip delay group: once one tooltip opens, adjacent
    // ones open instantly (Base UI grouping). `delay` only exists on the
    // Provider, so this is the one knob for hover timing across the app.
    <TooltipProvider delay={600}>
      <SyncingProvider>
        <PrivateModeBanner />
        {/* AQU-293: session-expiry banner — must be inside Router (uses useLocation) */}
        <SessionExpiredBanner />
        <SyncFreezeOverlay />
        <OrgProvider>
          <OutboxProvider>
            {/* AQU-243: ProductTourProvider mounts once here; the tour portal
                renders into document.body so it is route-agnostic. The context
                value (openTour) is consumed by OrgSidebar's "Take the tour" button. */}
            <ProductTourProvider>
              <NavHistoryProvider>
                <AppRoutes />
              </NavHistoryProvider>
            </ProductTourProvider>
          </OutboxProvider>
        </OrgProvider>
        <AiModelConsentDialog />
        <AiModelDownloadChip />
        <AudioBulkProgressBanner />
        <GlobalAudioShortcuts />
        <VersionBadge />
        <UpdateBanner />
        <Toaster />
      </SyncingProvider>
    </TooltipProvider>
  )
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <Routes>
        {/* Eager — needed for first paint / sign-in flow */}
        <Route path="/" element={<RootRedirect />} />
        <Route path="/projects" element={<Navigate to={resumeOrgPath()} replace />} />
        <Route path="/projects/:id" element={<ProjectOverview />} />
        <Route path="/shared" element={<SharedProjectsPage />} />
        <Route path="/join/:token" element={<JoinPage />} />
        {/* AQU-626: per-user deep link + PIN — public, eager (fresh-browser
            diode-zone flow lands here with no session and no onboarding). */}
        <Route path="/link/:token" element={<AccessLinkPage />} />
        {/* Agent API (AQU-533 §3) — one-time human approval for ask-mode changesets. */}
        <Route path="/approve/:changesetId" element={<ApproveChangeset />} />
        <Route path="/join-org/:token" element={<JoinOrgPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/onboarding" element={<OnboardingWizard />} />
        {/* AQU-282: dedicated login — eagerly loaded (public, no auth required) */}
        <Route path="/login" element={<Login />} />
        {/* AQU-270: account recovery — eagerly loaded (public, no auth required) */}
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/privacy-policy" element={<PrivacyPolicy />} />
        {/* Dev-only auto-login/logout — see components/DevLoginRoute.tsx */}
        <Route path="/__dev/login" element={<DevLoginRoute />} />
        <Route path="/__dev/logout" element={<DevLogoutRoute />} />
        {/* Curated marketing/demo auto-login — see components/MarketingLoginRoute.tsx */}
        <Route path="/__marketing/login" element={<MarketingLoginRoute />} />

        <Route path="/preferences" element={<Preferences />} />
        <Route path="/preferences/:section" element={<Preferences />} />

        {/* Org shell — path is authoritative for active org. `/orgs/all` is home-only. */}
        <Route path="/orgs/all" element={<OrgHome />} />
        <Route path="/orgs/:orgId" element={<OrgRouteGate />}>
          <Route index element={<OrgHome />} />
          <Route path="assigned" element={<AssignedToMe />} />
          <Route path="archived" element={<ArchivedProjects />} />
          <Route path="teams" element={<TeamsList />} />
          <Route path="teams/:groupId" element={<TeamDetail />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="members/matrix" element={<MembersPage />} />
          <Route path="settings" element={<Settings />} />
          <Route path="settings/identity" element={<OrgSettingsIdentity />} />
          <Route path="settings/export" element={<OrgSettingsExport />} />
          <Route path="settings/roster" element={<OrgSettingsRoster />} />
          <Route path="settings/assignment" element={<OrgSettingsAssignment />} />
          <Route path="settings/providers" element={<OrgSettingsProviders />} />
          <Route path="settings/monday" element={<OrgSettingsMonday />} />
        </Route>

        {/* Project routes stay flat (not nested under /orgs).
            Default work surface is explicit: /project/:id/editor[/file/:fileId].
            Bare /project/:id and /project/:id/file/:fileId are intentionally dead. */}
        <Route path="/project/:id/editor" element={<ProjectWorkspace />} />
        <Route path="/project/:id/editor/file/:fileId" element={<ProjectWorkspace />} />
        <Route path="/project/:id/settings" element={<ProjectSettings />} />
        <Route path="/project/:id/settings/:section" element={<ProjectSettings />} />
        <Route path="/project/:id/rules" element={<ProjectWorkspace />} />
        <Route path="/project/:id/agent" element={<ProjectWorkspace />} />
        <Route path="/project/:id/voice" element={<ProjectWorkspace />} />
        <Route path="/project/:id/terminology" element={<ProjectWorkspace />} />
        <Route path="/project/:id/comments" element={<ProjectWorkspace />} />
        <Route path="/project/:id/memory" element={<ProjectWorkspace />} />
        <Route path="/project/:id/members" element={<ProjectWorkspace />} />

        {/* Monday.com OAuth redirect URI (top-level; see MondayOAuthCallback).
            Monday's registered redirect URI is a fixed top-level SPA path, so
            it cannot live under the /orgs/:orgId shell. */}
        <Route path="/oauth/callback" element={<MondayOAuthCallback />} />

        {/* Lazy — site-wide admin console (platform operators only; gated
            client-side by usePlatformAdmin and server-side by ADMIN_EMAILS) */}
        <Route path="/admin" element={<AdminConsole />} />

        {/* Lazy — debug views (dev/staging only) */}
        <Route path="/debug" element={<DebugView />} />
        <Route path="/project/:id/debug" element={<DebugView />} />
        <Route path="/project/:id/settings/debug" element={<DebugView />} />
        <Route path="/project/:id/comments/debug" element={<DebugView />} />

        {/* AQU-270: catch-all 404 — must be last (audit finding F-IA3) */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}
