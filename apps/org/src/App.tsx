// Org admin app — router shell.
//
// Per AD-11 / spec §21: this app owns org-wide member admin surfaces.
// Source workspace SPA equivalents:
//   - src/pages/MembersPage.tsx           → /org/members
//   - src/components/MembersMatrixView.tsx
//   - src/components/MembersMatrixCellEditor.tsx
//   - src/components/MultiProjectInviteDialog.tsx → /org/invite
//   - src/components/RemoveOrgMemberDialog.tsx
//
// Phase 3c scope (this PR):
//   - Vite + React Router scaffold at /org/.
//   - Org-list landing page reads from @aquilla/api-client (fetchUserOrgs).
//   - Members + invite pages are stubs that document what they replace.
//   - The full matrix component (~500 lines) ports when Phase 3a relocates
//     the useOrg / useOrgInvites / useProjectsMembersMatrix hooks.

import { BrowserRouter, Routes, Route } from "react-router-dom"
import { OrgListPage } from "./pages/OrgListPage"
import { MembersPage } from "./pages/MembersPage"
import { InvitePage } from "./pages/InvitePage"

export function App() {
  return (
    <BrowserRouter basename="/org">
      <Routes>
        <Route path="/" element={<OrgListPage />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/invite" element={<InvitePage />} />
      </Routes>
    </BrowserRouter>
  )
}
