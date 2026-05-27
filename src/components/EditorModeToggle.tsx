// Segmented "Translate | Voice" switch in the workspace header. The two modes
// are distinct routes (the editor under /project/:id[/file/:fileId], the Voice
// Studio under /project/:id/voice), so toggling is a navigation, not local
// state. Translate returns to the active file when one is known.

import { useNavigate } from "react-router-dom"
import { Mic2, Pencil } from "lucide-react"
import { cn } from "@/lib/utils"

interface Props {
  projectId: string
  mode: "translate" | "voice"
  /** When in translate context, the active file so Voice→Translate returns to it. */
  activeFileId?: string | null
}

export function EditorModeToggle({ projectId, mode, activeFileId }: Props) {
  const navigate = useNavigate()
  const translateHref = activeFileId
    ? `/project/${projectId}/file/${activeFileId}`
    : `/project/${projectId}`

  return (
    <div className="neu-inset flex items-center gap-0.5 rounded-full p-1 text-xs">
      <button
        type="button"
        onClick={() => mode !== "translate" && navigate(translateHref)}
        className={cn(
          "flex items-center gap-1 rounded-full px-2.5 py-1 transition-all",
          mode === "translate"
            ? "bg-card font-medium text-foreground shadow-neu-xs"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={mode === "translate"}
      >
        <Pencil className="h-3 w-3" /> Translate
      </button>
      <button
        type="button"
        onClick={() => mode !== "voice" && navigate(`/project/${projectId}/voice`)}
        className={cn(
          "flex items-center gap-1 rounded-full px-2.5 py-1 transition-all",
          mode === "voice"
            ? "bg-card font-medium text-foreground shadow-neu-xs"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={mode === "voice"}
      >
        <Mic2 className="h-3 w-3" /> Voice
      </button>
    </div>
  )
}
