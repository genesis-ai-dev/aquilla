import { Settings, Scale, Download, Search, MessagesSquare, Camera, Share2, Film } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { PeerState } from "@/hooks/useSync"
import type { SyncPhase, SyncResult } from "@/lib/sync/git-sync"
import type { FrontierSession } from "@/lib/frontier/types"
import { PeerPresence } from "./PeerPresence"
import { SyncButton } from "./SyncButton"
import { ViewSettingsMenu } from "./ViewSettingsMenu"
import { HeaderAuth } from "@/components/git-import/HeaderAuth"

interface ToolbarProps {
  project: ProjectRecord
  onBack: () => void
  onImport: () => void
  onSettings: () => void
  onRules: () => void
  onExport: () => void
  onSearch: () => void
  onComments: () => void
  onSnapshots: () => void
  onShare: () => void
  peers?: PeerState[]
  exportEnabled: boolean
  fileOpen: boolean
  lineNumbersEnabled: boolean
  sourceTextDirection: "ltr" | "rtl"
  targetTextDirection: "ltr" | "rtl"
  cellLabelsEnabled: boolean
  rtlHintDismissed?: boolean
  onLineNumbersChange: (v: boolean) => void
  onSourceTextDirectionChange: (v: "ltr" | "rtl") => void
  onTargetTextDirectionChange: (v: "ltr" | "rtl") => void
  onCellLabelsChange: (v: boolean) => void
  onDismissRtlHint?: () => void
  onVideo?: () => void
  checklistProgress?: { completed: number; total: number }
  onOpenChecklist?: () => void
  onProjectUpdated: (p: ProjectRecord) => void
  sync: (project: ProjectRecord, session: FrontierSession) => Promise<SyncResult | null>
  syncPhase: SyncPhase
  syncInFlight: boolean
  syncLastResult: SyncResult | null
}

export function Toolbar({
  project, onBack, onImport, onSettings, onRules, onExport,
  onSearch, onComments, onSnapshots, onShare, peers = [], exportEnabled,
  fileOpen, lineNumbersEnabled, sourceTextDirection, targetTextDirection, cellLabelsEnabled, rtlHintDismissed,
  onLineNumbersChange, onSourceTextDirectionChange, onTargetTextDirectionChange, onCellLabelsChange, onDismissRtlHint,
  onVideo,
  checklistProgress, onOpenChecklist,
  onProjectUpdated, sync, syncPhase, syncInFlight, syncLastResult,
}: ToolbarProps) {
  return (
    <header className="flex items-center gap-4 border-b px-4 py-2">
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← Back
      </Button>
      <h2 className="font-semibold">{project.name}</h2>
      <span className="text-sm text-muted-foreground">
        {project.sourceLanguage} → {project.targetLanguage}
      </span>
      <PeerPresence peers={peers} />
      <div className="flex-1" />
      <SyncButton
        project={project}
        onUpdated={onProjectUpdated}
        sync={sync}
        phase={syncPhase}
        inFlight={syncInFlight}
        lastResult={syncLastResult}
      />
      <ViewSettingsMenu
        fileOpen={fileOpen}
        lineNumbersEnabled={lineNumbersEnabled}
        sourceTextDirection={sourceTextDirection}
        targetTextDirection={targetTextDirection}
        cellLabelsEnabled={cellLabelsEnabled}
        rtlHintDismissed={rtlHintDismissed}
        onLineNumbersChange={onLineNumbersChange}
        onSourceTextDirectionChange={onSourceTextDirectionChange}
        onTargetTextDirectionChange={onTargetTextDirectionChange}
        onCellLabelsChange={onCellLabelsChange}
        onDismissRtlHint={onDismissRtlHint}
      />
      <Button variant="ghost" size="sm" onClick={onSearch} title="Search (Cmd+K)">
        <Search className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={onShare} title="Share project">
        <Share2 className="h-4 w-4" />
      </Button>
      {onVideo && (
        <Button variant="ghost" size="sm" onClick={onVideo} title="Attach video">
          <Film className="h-4 w-4" />
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onComments} title="Comments">
        <MessagesSquare className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={onSnapshots} title="Snapshots">
        <Camera className="h-4 w-4" />
      </Button>
      <Button size="sm" onClick={onImport}>
        + Import
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onExport}
        disabled={!exportEnabled}
        title={exportEnabled ? "Export translated file" : "Select a file to export"}
      >
        <Download className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={onRules} title="Translation rules">
        <Scale className="h-4 w-4" />
      </Button>
      {checklistProgress && checklistProgress.completed < checklistProgress.total && onOpenChecklist && (
        <button
          onClick={onOpenChecklist}
          className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent"
          title="Open setup checklist"
        >
          Setup: {checklistProgress.completed}/{checklistProgress.total}
        </button>
      )}
      <HeaderAuth />
      <Button variant="ghost" size="sm" onClick={onSettings}>
        <Settings className="h-4 w-4" />
      </Button>
    </header>
  )
}
