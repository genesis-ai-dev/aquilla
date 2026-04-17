import { Routes, Route } from "react-router-dom"
import { Dashboard } from "@/components/Dashboard"
import { ProjectWorkspace } from "@/components/ProjectWorkspace"
import { ProjectSettings } from "@/components/ProjectSettings"
import { DebugView } from "@/components/DebugView"
import { RulesPage } from "@/components/RulesPage"
import { CommentsPage } from "@/components/CommentsPage"
import { SnapshotsPage } from "@/components/SnapshotsPage"
import { JoinPage } from "@/components/JoinPage"
import { SyncingProvider, useSyncing } from "@/context/SyncingContext"

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
      <SyncFreezeOverlay />
      <AppRoutes />
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
      <Route path="/project/:id/comments" element={<CommentsPage />} />
      <Route path="/project/:id/comments/debug" element={<DebugView />} />
      <Route path="/project/:id/snapshots" element={<SnapshotsPage />} />
      <Route path="/project/:id/snapshots/debug" element={<DebugView />} />
      <Route path="/join/:token" element={<JoinPage />} />
    </Routes>
  )
}
