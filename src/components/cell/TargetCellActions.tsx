import { useState } from "react"
import { History, MessageCircle, RefreshCw, Sparkles } from "lucide-react"
import { GenerateOverwriteDialog } from "@/components/GenerateOverwriteDialog"
import { RailButton } from "@/components/CellActionRail"
import { getSkipReplaceConfirm, setSkipReplaceConfirm } from "@/lib/store/replace-confirm-pref"

interface TargetDraftActionsProps {
  targetText: string
  status?: string
  editable: boolean
  isAnonymous: boolean
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  isLoading: boolean
  onDraft: () => unknown
  onRegenerate?: () => unknown
  onAiSetupNeeded?: () => void
  onDragStart?: (event: React.MouseEvent) => void
  onDragEnter?: () => void
  onConfirmOpenChange?: (open: boolean) => void
}

/**
 * The editor's actual per-cell AI actions. Both the grid and agent workbench
 * use this component so their overwrite safeguards and availability gates
 * cannot drift apart.
 */
export function TargetDraftActions({
  targetText,
  status,
  editable,
  isAnonymous,
  isCompletionConfigured,
  isCompletionAvailable,
  isLoading,
  onDraft,
  onRegenerate,
  onAiSetupNeeded,
  onDragStart,
  onDragEnter,
  onConfirmOpenChange,
}: TargetDraftActionsProps) {
  const [confirmOpen, setConfirmOpenState] = useState(false)
  const isValidated = status === "validated"

  const setConfirmOpen = (open: boolean) => {
    setConfirmOpenState(open)
    onConfirmOpenChange?.(open)
  }

  const runDraft = () => {
    void Promise.resolve(onDraft())
  }

  const requestDraft = () => {
    if (isLoading) return
    if (!isCompletionConfigured && editable && !isAnonymous) {
      onAiSetupNeeded?.()
      return
    }
    if (!isCompletionConfigured || !isCompletionAvailable || !editable || isAnonymous) return

    if (targetText.trim()) {
      if (!isValidated && getSkipReplaceConfirm()) runDraft()
      else setConfirmOpen(true)
      return
    }
    runDraft()
  }

  return (
    <>
      <RailButton
        icon={<Sparkles className="h-3.5 w-3.5" />}
        tooltip={
          isAnonymous
            ? "Sign in for AI translations"
            : !editable
              ? "Read-only (imported from git)"
              : !isCompletionConfigured
                ? "Set up AI to enable"
                : !isCompletionAvailable
                  ? "AI service unavailable — try again shortly"
                  : isLoading
                    ? "Generating…"
                    : "Translate with AI"
        }
        onClick={requestDraft}
        disabled={
          (!isCompletionConfigured && !onAiSetupNeeded) ||
          !isCompletionAvailable ||
          !editable ||
          isAnonymous ||
          isLoading
        }
        pulsing={isLoading}
        onMouseDown={onDragStart}
        onMouseEnter={onDragEnter}
      />

      {editable && !isAnonymous && status !== "validated" && targetText.trim() && onRegenerate && (
        <RailButton
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          tooltip={
            !isCompletionConfigured
              ? "Set up AI to enable"
              : !isCompletionAvailable
                ? "AI service unavailable — try again shortly"
                : isLoading
                  ? "Generating…"
                  : "Regenerate — another AI variation"
          }
          onClick={() => {
            if (isLoading) return
            if (!isCompletionConfigured) {
              onAiSetupNeeded?.()
              return
            }
            if (isCompletionAvailable) void Promise.resolve(onRegenerate())
          }}
          disabled={
            (!isCompletionConfigured && !onAiSetupNeeded) ||
            !isCompletionAvailable ||
            isLoading
          }
          pulsing={isLoading}
        />
      )}

      <GenerateOverwriteDialog
        open={confirmOpen}
        isValidated={isValidated}
        onConfirm={(dontAskAgain) => {
          setConfirmOpen(false)
          if (dontAskAgain) setSkipReplaceConfirm(true)
          runDraft()
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}

interface TargetReferenceActionsProps {
  cellId: string
  openCommentCount?: number
  onOpenComments?: (cellId: string) => void
  onOpenHistory?: (cellId: string) => void
}

/** Shared comment/history actions for every target-cell presentation. */
export function TargetReferenceActions({
  cellId,
  openCommentCount = 0,
  onOpenComments,
  onOpenHistory,
}: TargetReferenceActionsProps) {
  return (
    <>
      {onOpenComments && (
        <RailButton
          icon={<MessageCircle className="h-3.5 w-3.5" />}
          tooltip={openCommentCount > 0
            ? `${openCommentCount} open comment${openCommentCount !== 1 ? "s" : ""}`
            : "Add comment"}
          onClick={() => onOpenComments(cellId)}
          toneClass={openCommentCount > 0 ? "text-primary hover:text-primary" : undefined}
          dot={openCommentCount > 0 ? "primary" : undefined}
        />
      )}
      {onOpenHistory && (
        <RailButton
          icon={<History className="h-3.5 w-3.5" />}
          tooltip="Edit history"
          onClick={() => onOpenHistory(cellId)}
        />
      )}
    </>
  )
}
