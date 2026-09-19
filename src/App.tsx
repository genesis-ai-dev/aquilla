import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Navigate, Routes, Route, useParams, useLocation, type Location } from "react-router-dom"
import { OrgHome } from "@/components/org/OrgHome"
import { OrgHomeRoute } from "@/components/org/OrgHomeRoute"
import { OrgOverview } from "@/components/org/OrgOverview"
import { OrgProjectsPage } from "@/components/org/OrgProjectsPage"
import { OrgRouteGate } from "@/components/org/OrgRouteGate"
import { ProductTourProvider } from "@/context/ProductTourContext"
import { ArchivedProjects } from "@/components/org/ArchivedProjects"
import { ProjectOverview } from "@/components/org/ProjectOverview"
import { AssignedToMe } from "@/components/org/AssignedToMe"
import { SharedProjectsPage } from "@/components/org/SharedProjectsPage"
import { resumeOrgPath, projectMemoryPath } from "@/lib/navigation/org-paths"
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
import { Preferences, PreferencesDialog } from "@/pages/Preferences"
import { SyncingProvider, useSyncing } from "@/context/SyncingContext"
import { OrgProvider } from "@/context/OrgContext"
import { OutboxProvider } from "@/context/OutboxContext"
import { OfflineStoreProvider } from "@/context/OfflineStoreContext"
import { OfflineSyncManagerMount } from "@/components/OfflineSyncManagerMount"
import { UnsyncedOfflineWorkGuard } from "@/components/UnsyncedOfflineWorkGuard"
import { OfflineShutdownGuard } from "@/components/OfflineShutdownGuard"
import { LocalLlmConfigMount } from "@/components/LocalLlmConfigMount"
import { ConflictToast } from "@/components/ConflictToast"
import { NavHistoryProvider } from "@/context/NavHistoryContext"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { Toaster } from "@/components/ui/toast"
import { AiModelConsentDialog } from "@/components/AiModelConsentDialog"
import { AiModelDownloadChip } from "@/components/AiModelDownloadChip"
import { AudioBulkProgressBanner } from "@/components/AudioBulkProgressBanner"
import { PrivateModeBanner } from "@/components/PrivateModeBanner"
import { SessionExpiredBanner } from "@/components/SessionExpiredBanner"
import { ExpiredSessionGate } from "@/components/ExpiredSessionGate"
import { useAccounts } from "@/hooks/useAccounts"
import {
  hasLegacyOnboardingCompletion,
  isLocalOnboardingComplete,
  migrateLegacyOnboardingCompletion,
} from "@/lib/onboarding/completion"
import { isJwtExpired } from "@/lib/frontier/auth"
import { SessionHydrationError } from "@/components/SessionHydrationError"
import { AccountTransitionError } from "@/components/AccountTransitionError"
import { isSessionHydrationRequiredPath } from "@/lib/navigation/session-routes"
import { VersionBadge } from "@/components/VersionBadge"
import { UpdateBanner } from "@/components/UpdateBanner"
import { hydratePrefetchStatus } from "@/lib/audio/prefetch"
import { probeOpfsAvailability } from "@/lib/storage/opfs-availability"
import { useT } from "@/lib/i18n/I18nProvider"
import { useGlobalAudioShortcuts } from "@/hooks/useGlobalAudioShortcuts"
import { useSessionRefresh } from "@/hooks/useSessionRefresh"

// Heavy workspace / admin routes — loaded only when navigated to
const ProjectWorkspace = lazy(() =>
  import("@/components/ProjectWorkspace").then((m) => ({ default: m.ProjectWorkspace })),
)
const OrgDataEgress = lazy(() =>
  import("@/pages/OrgDataEgress").then((m) => ({ default: m.OrgDataEgress })),
)
const ProjectSettings = lazy(() =>
  import("@/components/ProjectSettings").then((m) => ({ default: m.ProjectSettings })),
)
const ProjectSettingsDialog = lazy(() =>
  import("@/components/ProjectSettings").then((m) => ({ default: m.ProjectSettingsDialog })),
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
const OrgSettingsSecurity = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsSecurity })),
)
const OrgSettingsBilling = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsBilling })),
)
const OrgSettingsProviders = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsProviders })),
)
const OrgSettingsMonday = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsMonday })),
)
const OrgSettingsRules = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsRules })),
)
const OrgSettingsKnowledge = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.OrgSettingsKnowledge })),
)
// Monday OAuth landing — Monday's registered redirect URI is this SPA route.
const ConnectAgent = lazy(() =>
  import("@/pages/ConnectAgent").then((m) => ({ default: m.ConnectAgent })),
)
const MondayOAuthCallback = lazy(() =>
  import("@/pages/settings/MondayOAuthCallback").then((m) => ({ default: m.MondayOAuthCallback })),
)
const TeamsList = lazy(() =>
  import("@/components/org/TeamsList").then((m) => ({ default: m.TeamsList })),
)
const TeamDetail = lazy(() =>
  import("@/components/org/TeamDetail").then((m) => ({ default: m.TeamDetail })),
)
const TeamSettingsIndex = lazy(() =>
  import("@/pages/TeamSettings").then((m) => ({ default: m.TeamSettingsIndex })),
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
// AQU-841 — the project-scoped queue of everything an agent staged here, so
// reviewing external-agent work stops meaning one approval URL per changeset.
const ProjectApprovals = lazy(() =>
  import("@/pages/ProjectApprovals/ProjectApprovals").then((m) => ({ default: m.ProjectApprovals })),
)
void hydratePrefetchStatus()
void probeOpfsAvailability()

function GlobalAudioShortcuts() {
  useGlobalAudioShortcuts()
  return null
}

function SyncFreezeOverlay() {
  const t = useT()
  const { syncing } = useSyncing()
  if (!syncing) return null
  return (
    <div className="fixed top-0 left-0 right-0 z-40 bg-amber-50 text-amber-800 border-b border-amber-200 px-3 py-1 text-xs text-center">
      {t("workspace.syncFreezeOverlay")}
    </div>
  )
}

/**
 * Workspace entry point, mounted at both `/app` and `/`.
 *
 * The separate marketing Worker owns `/` on the live custom domains, so a fresh
 * production load never reaches this component there. The app Worker and local
 * Vite server still expose `/` as a SPA fallback; `/app` is the stable workspace
 * entry linked by the marketing site.
 *
 * Signed-out visitors go to /login rather than back to the marketing page:
 * anyone arriving here clicked something that said "open the app", and bouncing
 * them to the page they just left would read as a broken link. A user who
 * completed onboarding counts as signed in — they may be working on local-only
 * projects without a Frontier account.
 *
 * Signed-in visitors resume their last org (`/orgs/$id` or `/orgs/all`).
 */
function AppEntry() {
  const { active } = useAccounts()
  const [localOnboarded, setLocalOnboarded] = useState<boolean | null>(() =>
    isLocalOnboardingComplete() ? true : hasLegacyOnboardingCompletion() ? null : false,
  )
  const [migrationError, setMigrationError] = useState<Error | null>(null)
  const migrationRequestRef = useRef(0)
  const migrationInFlightRef = useRef(false)

  const runLocalMigration = useCallback(async () => {
    if (migrationInFlightRef.current) return
    migrationInFlightRef.current = true
    const request = ++migrationRequestRef.current
    setMigrationError(null)
    try {
      const complete = await migrateLegacyOnboardingCompletion(null)
      if (migrationRequestRef.current === request) setLocalOnboarded(complete)
    } catch (error) {
      if (migrationRequestRef.current === request) {
        setMigrationError(error instanceof Error ? error : new Error(String(error)))
      }
    } finally {
      migrationInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (active) {
      void migrateLegacyOnboardingCompletion(active.username).catch(() => {})
      return
    }
    if (isLocalOnboardingComplete() || localOnboarded !== null || migrationError) return
    // Start after the effect body so the retry helper's initial state reset is
    // not a synchronous state update from inside an effect.
    void Promise.resolve().then(() => {
      if (!cancelled) return runLocalMigration()
    })
    return () => {
      cancelled = true
      migrationRequestRef.current += 1
    }
  }, [active, localOnboarded, migrationError, runLocalMigration])

  if (active && isJwtExpired(active.jwt)) return <RouteLoadingFallback />
  if (!active && migrationError) {
    return (
      <SessionHydrationError
        retry={runLocalMigration}
        messageKey="auth.login.onboardingMigrationFailed"
      />
    )
  }
  if (!active && localOnboarded == null) return <RouteLoadingFallback />
  if (!active && !localOnboarded) return <Navigate to="/login" replace />
  return <Navigate to={resumeOrgPath()} replace />
}

/** Fallback used while lazy route chunks are loading (e.g. the workspace). */
function RouteLoadingFallback() {
  return <LoadingOverlay />
}

/** Preserve bookmarks and e2e gotos to retired paths that moved into Living Memory. */
function RedirectToProjectMemory({ section }: { section?: string }) {
  const { id } = useParams<{ id: string }>()
  const { search } = useLocation()
  return <Navigate to={`${projectMemoryPath(id!, section)}${search}`} replace />
}

function LazyRoute({ children, fallback = <RouteLoadingFallback /> }: { children: ReactNode; fallback?: ReactNode }) {
  return <Suspense fallback={fallback}>{children}</Suspense>
}

function OrgLazyRoute({ children }: { children: ReactNode }) {
  // Do not catch suspension here. OrgSidebar navigates in a transition, so
  // bubbling to the existing outer boundary lets React retain the useful
  // source screen while a chunk resolves. On a direct cold URL there is no
  // source screen, and the outer boundary correctly shows its full loader.
  // Destination pages still own explicit loaders for authoritative data waits.
  return children
}

export default function App() {
  // AQU-995: roll the stored JWT forward while the session is in use, so a
  // 30-day token never lapses under someone who is actively translating.
  useSessionRefresh()
  const {
    active, loading, hydrated, loadError, retryLoad,
    transitionError, retryTransition,
  } = useAccounts()
  const location = useLocation()
  const hydrationRequired = isSessionHydrationRequiredPath(location.pathname)
  const offlineProjectTransition = hydrated && location.pathname.startsWith("/project/")
  if (transitionError) {
    return <AccountTransitionError retry={retryTransition} />
  }
  // Offline/public routes may render before the first IndexedDB session read,
  // while offline project routes still need a neutral boundary during a real
  // account switch. Public/login routes stay mounted so a pending form submit
  // retains ownership of its exact post-auth `next` navigation.
  if (loading && (hydrationRequired || offlineProjectTransition)) {
    return <RouteLoadingFallback />
  }
  if (hydrationRequired && loadError && !active) {
    return <SessionHydrationError retry={retryLoad} />
  }

  return (
    // Single app-wide tooltip delay group: once one tooltip opens, adjacent
    // ones open instantly (Base UI grouping). `delay` only exists on the
    // Provider, so this is the one knob for hover timing across the app.
    <OfflineStoreProvider>
      <OfflineSyncManagerMount />
      <UnsyncedOfflineWorkGuard />
      <OfflineShutdownGuard />
      <LocalLlmConfigMount />
      <TooltipProvider delay={600}>
        <SyncingProvider>
          <PrivateModeBanner />
          <ConflictToast />
          {/* AQU-293: session-expiry banner — must be inside Router (uses useLocation) */}
          <SessionExpiredBanner />
          {/* AQU-885: a stored JWT that's already expired at boot goes straight to
              re-auth instead of rendering a shell that silently empties out. */}
          <ExpiredSessionGate />
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
    </OfflineStoreProvider>
  )
}

function AppRoutes() {
  const location = useLocation()
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation

  return (
    <>
      {/* Workspace routes intentionally suspend to this outer boundary: when
          entered through useOpenWorkspace's transition, React keeps the source
          project overview mounted so its blocking "Opening project" overlay
          remains observable. Org lazy routes catch suspension locally below. */}
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes location={backgroundLocation ?? location}>
        {/* Eager — needed for first paint / sign-in flow */}
        <Route path="/" element={<AppEntry />} />
        {/* The workspace entry. `/` is marketing at the edge, so this is the
            URL that opens the app — marketing "Open app" CTAs point here. */}
        <Route path="/connect-agent" element={<LazyRoute><ConnectAgent /></LazyRoute>} />
        <Route path="/app" element={<AppEntry />} />
        <Route path="/projects" element={<Navigate to={resumeOrgPath()} replace />} />
        <Route path="/projects/:id" element={<ProjectOverview />} />
        <Route path="/shared" element={<SharedProjectsPage />} />
        <Route path="/join/:token" element={<JoinPage />} />
        {/* AQU-626: per-user deep link + PIN — public, eager (fresh-browser
            diode-zone flow lands here with no session and no onboarding). */}
        <Route path="/link/:token" element={<AccessLinkPage />} />
        {/* Agent API (AQU-533 §3) — one-time human approval for ask-mode changesets. */}
        <Route path="/approve/:changesetId" element={<LazyRoute><ApproveChangeset /></LazyRoute>} />
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
          {/* AQU-790: index → guest /projects or member /overview. */}
          <Route index element={<OrgHomeRoute />} />
          <Route path="overview" element={<OrgOverview />} />
          <Route path="projects" element={<OrgProjectsPage />} />
          <Route path="assigned" element={<AssignedToMe />} />
          <Route path="archived" element={<ArchivedProjects />} />
          <Route path="archived/files" element={<ArchivedProjects />} />
          <Route path="egress" element={<OrgLazyRoute><OrgDataEgress /></OrgLazyRoute>} />
          <Route path="teams" element={<OrgLazyRoute><TeamsList /></OrgLazyRoute>} />
          <Route path="teams/:groupId" element={<OrgLazyRoute><TeamDetail /></OrgLazyRoute>} />
          <Route path="teams/:groupId/settings" element={<OrgLazyRoute><TeamSettingsIndex /></OrgLazyRoute>} />
          <Route
            path="teams/:groupId/settings/identity"
            element={<Navigate to=".." replace relative="path" />}
          />
          <Route path="members" element={<OrgLazyRoute><MembersPage /></OrgLazyRoute>} />
          <Route path="members/matrix" element={<OrgLazyRoute><MembersPage /></OrgLazyRoute>} />
          <Route path="settings" element={<OrgLazyRoute><Settings /></OrgLazyRoute>} />
          <Route path="settings/identity" element={<OrgLazyRoute><OrgSettingsIdentity /></OrgLazyRoute>} />
          <Route path="settings/security" element={<OrgLazyRoute><OrgSettingsSecurity /></OrgLazyRoute>} />
          <Route path="settings/billing" element={<OrgLazyRoute><OrgSettingsBilling /></OrgLazyRoute>} />
          <Route path="settings/export" element={<Navigate to="../security" replace relative="path" />} />
          <Route path="settings/roster" element={<Navigate to="../security" replace relative="path" />} />
          <Route path="settings/assignment" element={<Navigate to="../security" replace relative="path" />} />
          <Route path="settings/terminology" element={<Navigate to="../security" replace relative="path" />} />
          <Route path="settings/providers" element={<OrgLazyRoute><OrgSettingsProviders /></OrgLazyRoute>} />
          {/* AQU-1131: org rules are a top-level Settings section, not a
              project's Living Memory pane. */}
          <Route path="settings/rules" element={<OrgLazyRoute><OrgSettingsRules /></OrgLazyRoute>} />
          <Route path="settings/knowledge" element={<OrgLazyRoute><OrgSettingsKnowledge /></OrgLazyRoute>} />
          <Route path="settings/monday" element={<OrgLazyRoute><OrgSettingsMonday /></OrgLazyRoute>} />
        </Route>

        {/* Project routes stay flat (not nested under /orgs).
            Default work surface is explicit: /project/:id/editor[/file/:fileId].
            Bare /project/:id and /project/:id/file/:fileId are intentionally dead. */}
        <Route path="/project/:id/editor" element={<ProjectWorkspace />} />
        <Route path="/project/:id/editor/file/:fileId" element={<ProjectWorkspace />} />
        <Route path="/project/:id/settings" element={<LazyRoute><ProjectSettings /></LazyRoute>} />
        <Route path="/project/:id/settings/:section" element={<LazyRoute><ProjectSettings /></LazyRoute>} />
        {/* Rules now live on Living Memory's "Translation quality" pane. */}
        <Route path="/project/:id/rules" element={<RedirectToProjectMemory section="quality" />} />
        {/* AQU-841 — in-app approvals queue for agent-staged changesets. */}
        <Route path="/project/:id/approvals" element={<LazyRoute><ProjectApprovals /></LazyRoute>} />
        <Route path="/project/:id/agent" element={<ProjectWorkspace />} />
        <Route path="/project/:id/voice" element={<ProjectWorkspace />} />
        <Route path="/project/:id/terminology" element={<ProjectWorkspace />} />
        <Route path="/project/:id/comments" element={<ProjectWorkspace />} />
        <Route path="/project/:id/memory" element={<ProjectWorkspace />} />
        <Route path="/project/:id/memory/:section" element={<ProjectWorkspace />} />

        {/* Monday.com OAuth redirect URI. Stays top-level and un-scoped: the
            path is registered with Monday, so it cannot carry an org segment. */}
        <Route path="/oauth/callback" element={<LazyRoute><MondayOAuthCallback /></LazyRoute>} />


        {/* Lazy — site-wide admin console (platform operators only; gated
            client-side by usePlatformAdmin and server-side by ADMIN_EMAILS) */}
        <Route path="/admin" element={<LazyRoute><AdminConsole /></LazyRoute>} />

        {/* Lazy — debug views (dev/staging only) */}
        <Route path="/debug" element={<LazyRoute><DebugView /></LazyRoute>} />
        <Route path="/project/:id/debug" element={<LazyRoute><DebugView /></LazyRoute>} />
        <Route path="/project/:id/settings/debug" element={<LazyRoute><DebugView /></LazyRoute>} />
        <Route path="/project/:id/comments/debug" element={<LazyRoute><DebugView /></LazyRoute>} />

        {/* AQU-270: catch-all 404 — must be last (audit finding F-IA3) */}
        <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      {backgroundLocation ? (
        <Routes>
          <Route path="/preferences" element={<PreferencesDialog />} />
          <Route path="/preferences/:section" element={<PreferencesDialog />} />
          <Route path="/project/:id/settings" element={<LazyRoute><ProjectSettingsDialog /></LazyRoute>} />
          <Route path="/project/:id/settings/:section" element={<LazyRoute><ProjectSettingsDialog /></LazyRoute>} />
        </Routes>
      ) : null}
    </>
  )
}
