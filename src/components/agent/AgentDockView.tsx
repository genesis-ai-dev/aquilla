/**
 * AgentDockView.tsx — Agent mode body for the chat dock.
 *
 * A thin mount over the project's shared agent session
 * (src/lib/agent/session-store.ts): the store owns runs/streaming/queueing
 * and the server-session id, so the full-screen workbench renders the SAME
 * conversation and an in-flight run survives dock unmounts. This component
 * owns only presentation wiring: composer, context pin, proposal Apply.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Bot, Paperclip, X } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { ChatComposer, type ChatComposerHandle, type SuggestedAction } from "@/components/chat/ChatComposer"
import { ChatContextPin } from "@/components/chat/ChatContextPin"
import { InputGroupButton } from "@/components/ui/input-group"
import type { CellContext } from "@/lib/cell-context"
import { serializeWithChips, type ContextChip } from "@/lib/agent/context-chip"
import { uploadAgentArtifact, ArtifactUploadError } from "@/lib/agent/artifact-upload"
import { expandSlashCommand } from "@/lib/agent/slash-commands"
import { getTranslatorProfile, profileForPrompt } from "@/lib/translator-profile"
import type { CellData } from "@/hooks/useCells"
import type { TranslationRule } from "@/lib/parsers/types"
import type { ApplyContext } from "@/lib/agent/apply"
import type { AgentProposal } from "@/lib/agent/protocol"
import { useAgentSession } from "@/lib/agent/session-store"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { AgentEmptyState } from "./AgentEmptyState"
import { AgentRunView } from "./AgentRunView"
import { PassageCard } from "./cards/PassageCard"
import { passageRowsFor } from "./cards/registry"
import { ProposalCard } from "./ProposalCard"
import { AquiferProposalCard } from "./AquiferProposalCard"

export interface AgentDockViewProps {
  projectId: string
  /** Frontier session JWT; null = not signed in (composer disabled). */
  jwt: string | null
  /** Current username — author on applied events. */
  author: string
  /** Current user's project role level (project.syncRole.level). */
  roleLevel: number | null
  /** Focused file/cell ids — sent as run context when the pin is on. */
  context: { fileId?: string; cellId?: string }
  /** Open file's name — keeps the pin pill honest when only file context is sent. */
  fileName?: string
  /** Focused cell display info for the context pin strip. */
  currentCell: CellContext | null
  /** Project's active rules for proposal lint. */
  rules: TranslationRule[]
  /** Live cell lookup from useCells. */
  resolveCell?: (cellId: string) => CellData | undefined
  /** Post-apply hook: flush outbox + revalidate the touched cells. */
  onApplied?: (eventIds: string[], cellIds: string[]) => void | Promise<void>
  /** One-tap prompts shown above the composer (e.g. Summarize book/chapter). */
  suggestedActions?: SuggestedAction[]
  /** A prompt to run as soon as the view is ready (set when the user taps a
   *  suggested action from chat mode, which switches to agent mode). */
  pendingPrompt?: string | null
  /** Called once the pending prompt has been dispatched, so the parent clears it. */
  onPendingPromptConsumed?: () => void
  /** A chip to insert into the composer as soon as the view is ready (set when
   *  the user taps "Ask AI" on a source selection). */
  pendingChip?: ContextChip | null
  /** Called once the pending chip has been inserted, so the parent clears it. */
  onPendingChipConsumed?: () => void
  /** Workbench seam: render a proposal compactly (receipt) instead of the
   *  full ProposalCard. Return null to fall back to the card (e.g. for
   *  proposals the working set can't review). */
  renderProposalOverride?: (proposal: AgentProposal) => ReactNode | null
  /** Workbench seam: jump to the Memory tab from a memory/brief proposal
   *  notice. Omitted in the dock panel, which has no Memory tab. */
  onReviewMemory?: () => void
  /** Workbench seam: open the file explorer used to choose context. */
  onChooseContext?: () => void
  /** Reversible UI navigation requested by the agent's focus tool. */
  onFocusChange?: (fileId: string, cellId?: string, fileName?: string) => void
  /** The workbench places its file picker in the pane header. */
  hideContextPin?: boolean
}

export function AgentDockView({
  projectId,
  jwt,
  author,
  roleLevel,
  context,
  fileName,
  currentCell,
  rules,
  resolveCell,
  onApplied,
  suggestedActions,
  pendingPrompt,
  onPendingPromptConsumed,
  pendingChip,
  onPendingChipConsumed,
  renderProposalOverride,
  onReviewMemory,
  onChooseContext,
  onFocusChange,
  hideContextPin = false,
}: AgentDockViewProps) {
  const { state, send, stop, noteActivity } = useAgentSession(projectId)
  const [includeContext, setIncludeContext] = useState(true)
  const composerRef = useRef<ChatComposerHandle>(null)

  // Composer attach-file affordance (AQU-AGENT Wave-2). Chosen files are
  // uploaded as project artifacts immediately; the returned {artifactId,
  // fileName} pairs ride the next run request so the harness can load_artifact
  // them into the sandbox. Attachments clear once a prompt is sent.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<{ artifactId: string; fileName: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)

  const handleFilesChosen = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || !jwt) return
      setAttachError(null)
      setUploading(true)
      try {
        for (const file of Array.from(files)) {
          const uploaded = await uploadAgentArtifact(jwt, projectId, file)
          setAttachments((prev) => [...prev, { artifactId: uploaded.artifactId, fileName: uploaded.fileName }])
        }
      } catch (err) {
        setAttachError(
          err instanceof ArtifactUploadError ? err.message : "Could not attach that file. Try again.",
        )
      } finally {
        setUploading(false)
      }
    },
    [jwt, projectId],
  )

  const removeAttachment = useCallback((artifactId: string) => {
    setAttachments((prev) => prev.filter((a) => a.artifactId !== artifactId))
  }, [])

  const sendPrompt = useCallback(
    (text: string, chips: ContextChip[] = []) => {
      if ((!text.trim() && chips.length === 0) || !jwt) return
      // Slash commands expand into vetted prompts; the bubble keeps the typed
      // command (CLI-style). Chips skip expansion — a chip message is already
      // a specific ask, not a command.
      const expanded = chips.length === 0 ? expandSlashCommand(text) : null
      // `display` (with [ref] chips) shows in the bubble; `wire` (tokens +
      // legend) is what the model receives.
      const { wire, display } = expanded
        ? { wire: expanded, display: text.trim() }
        : serializeWithChips(text, chips)
      // Read the profile at send time (fresh, no extra re-render). The server
      // re-caps every field; this just avoids sending an empty object.
      const translatorProfile = profileForPrompt(getTranslatorProfile())
      send({
        wire,
        display,
        jwt,
        onFocusChange,
        request: {
          projectId,
          ...(includeContext && (context.fileId || context.cellId)
            ? { context: { ...context } }
            : {}),
          ...(translatorProfile ? { translatorProfile } : {}),
          ...(attachments.length > 0 ? { artifacts: attachments } : {}),
        },
      })
      // Attachments belong to the message that carried them — clear after send.
      if (attachments.length > 0) setAttachments([])
    },
    [jwt, send, projectId, includeContext, context, attachments, onFocusChange],
  )

  // Run a prompt handed in from a suggested action (tapped in chat mode, which
  // flips the dock to agent mode). The store queues it if a run is streaming,
  // so dispatch immediately and clear exactly once.
  useEffect(() => {
    if (!pendingPrompt || !jwt) return
    sendPrompt(pendingPrompt)
    onPendingPromptConsumed?.()
  }, [pendingPrompt, jwt, sendPrompt, onPendingPromptConsumed])

  // Insert a chip handed in from the editor's "Ask AI" selection action.
  useEffect(() => {
    if (!pendingChip) return
    composerRef.current?.insertChip(pendingChip)
    onPendingChipConsumed?.()
  }, [pendingChip, onPendingChipConsumed])

  const applyContext: ApplyContext = {
    projectId,
    author,
    resolveCell: resolveCell
      ? (cellId) => {
          const cell = resolveCell(cellId)
          return cell
            ? { targetEventId: cell.targetEventId, sourceEventId: cell.sourceEventId }
            : undefined
        }
      : undefined,
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!hideContextPin && (
        <ChatContextPin
          includeCellContext={includeContext}
          onToggle={setIncludeContext}
          currentCell={currentCell}
          fileName={fileName}
          onChooseContext={onChooseContext}
          compact
        />
      )}

      {state.runs.length === 0 ? (
        jwt ? (
          <AgentEmptyState onPromptSelect={(text) => composerRef.current?.insertText(text)} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-3 text-center text-muted-foreground">
            <Bot className="h-5 w-5" />
            <p className="text-xs">Sign in to use the agent.</p>
          </div>
        )
      ) : (
        <MessageScrollerProvider>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="px-3 py-2">
                {state.runs.map((run) => (
                  <MessageScrollerItem key={run.localId} messageId={run.localId} scrollAnchor>
                    <AgentRunView
                      run={run}
                      renderProposal={(proposal) =>
                        renderProposalOverride?.(proposal) ?? (
                          <ProposalCard
                            key={proposal.proposalId}
                            proposal={proposal}
                            roleLevel={roleLevel}
                            rules={rules}
                            resolveCell={resolveCell}
                            applyContext={applyContext}
                            onApplied={onApplied}
                          />
                        )
                      }
                      renderAquiferProposal={(proposal) => (
                        <AquiferProposalCard
                          key={proposal.proposalId}
                          proposal={proposal}
                          projectId={projectId}
                          jwt={jwt}
                        />
                      )}
                      renderToolCard={(item) => {
                        const rows = passageRowsFor(item)
                        return rows ? (
                          <PassageCard
                            cardKey={`${run.localId}:${item.id}`}
                            rows={rows}
                            projectId={projectId}
                            jwt={jwt}
                            onActivity={noteActivity}
                          />
                        ) : null
                      }}
                      onReviewMemory={onReviewMemory}
                    />
                  </MessageScrollerItem>
                ))}
                {state.queued.length > 0 && (
                  <div className="px-1 py-0.5 text-[11px] text-muted-foreground">
                    {state.queued.length === 1
                      ? "1 message queued — sends when the current run finishes."
                      : `${state.queued.length} messages queued — send in order when the current run finishes.`}
                  </div>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      )}

      <ChatComposer
        ref={composerRef}
        isStreaming={state.isStreaming}
        isConfigured={Boolean(jwt)}
        onSend={({ text, chips }) => sendPrompt(text, chips)}
        onStop={stop}
        compact
        suggestedActions={suggestedActions}
        queueWhileStreaming
        placeholder="Ask the agent… (/draft, /check, /find, /status)"
        attachmentBar={
          attachments.length > 0 || attachError ? (
            <div className="flex flex-col gap-1">
              {attachments.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {attachments.map((a) => (
                    <span
                      key={a.artifactId}
                      data-attachment-id={a.artifactId}
                      className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px]"
                    >
                      <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate font-mono">{a.fileName}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.artifactId)}
                        aria-label={`Remove ${a.fileName}`}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {attachError && (
                <p role="alert" className="text-[11px] text-destructive">
                  {attachError}
                </p>
              )}
            </div>
          ) : null
        }
        attachAction={
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              aria-hidden
              tabIndex={-1}
              onChange={(e) => {
                void handleFilesChosen(e.target.files)
                e.target.value = "" // allow re-selecting the same file
              }}
            />
            <InputGroupButton
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!jwt || uploading}
              aria-label="Attach file"
              title="Attach a file for the agent"
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? <Spinner /> : <Paperclip />}
            </InputGroupButton>
          </>
        }
      />
    </div>
  )
}
