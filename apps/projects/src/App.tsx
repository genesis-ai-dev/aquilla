// Projects app — router shell.
//
// Per AD-11 / spec §21: this app owns the project list landing page +
// project-create + project-settings + onboarding wizard + invite-acceptance
// (`/join/:token`).
//
// Phase 3c scope:
//   - Scaffold the Vite + React Router setup at /projects/.
//   - Wire the landing page (project list) to the auth-worker via
//     @aquilla/api-client (full Dashboard.tsx port lives in src/pages/ProjectList.tsx).
//   - Stub the other routes (`/new`, `/:id/settings`, `/onboarding`,
//     `/join/:token`) with placeholder pages that document what they replace.
//
// The full ports of ProjectSettings (~650 lines), OnboardingWizard (drags in
// 12 child components), and JoinPage (~170 lines) are intentionally NOT
// inlined here yet — copying them wholesale would require porting their
// hook + util dependency trees (useProject, useFrontierSession,
// project-index.ts, etc), which Phase 3a is responsible for. Phase 3c's
// job is to land the *app boundary* and prove the build/deploy path; the
// inner content lands when Phase 3a relocates the shared hooks into
// packages/ or apps/projects/src/hooks/.

import { BrowserRouter, Routes, Route } from "react-router-dom"
import { ProjectListPage } from "./pages/ProjectListPage"
import { ProjectCreatePage } from "./pages/ProjectCreatePage"
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage"
import { OnboardingPage } from "./pages/OnboardingPage"
import { JoinPage } from "./pages/JoinPage"
import { DebugAuthPage } from "./pages/DebugAuthPage"

export function App() {
  // basename MUST match index.html <base href> and vite.config.ts `base`.
  // Spec §21 base-path discipline.
  return (
    <BrowserRouter basename="/projects">
      <Routes>
        <Route path="/" element={<ProjectListPage />} />
        <Route path="/new" element={<ProjectCreatePage />} />
        <Route path="/:id/settings" element={<ProjectSettingsPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/join/:token" element={<JoinPage />} />
        {/* Diagnostic page (unlinked) — see pages/DebugAuthPage.tsx for context. */}
        <Route path="/debug" element={<DebugAuthPage />} />
      </Routes>
    </BrowserRouter>
  )
}
