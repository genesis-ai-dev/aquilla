import { Routes, Route } from "react-router-dom"
import { Dashboard } from "@/components/Dashboard"
import { ProjectWorkspace } from "@/components/ProjectWorkspace"
import { ProjectSettings } from "@/components/ProjectSettings"
import { DebugView } from "@/components/DebugView"
import { RulesPage } from "@/components/RulesPage"
import { CommentsPage } from "@/components/CommentsPage"
import { SnapshotsPage } from "@/components/SnapshotsPage"
import { JoinPage } from "@/components/JoinPage"

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/debug" element={<DebugView />} />
      <Route path="/project/:id" element={<ProjectWorkspace />} />
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
