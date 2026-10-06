/**
 * AgentDockView.tsx — Agent mode body for the chat dock.
 *
 * A thin mount over the project's shared agent session
 * (src/lib/agent/session-store.ts): the store owns runs/streaming/queueing
 * and the server-session id, so the full-screen workbench renders the SAME
 * conversation and an in-flight run survives dock unmounts. This component
 * owns only presentation wiring: composer, attachments, proposal Apply.
 * Unsent prose/chips and uploaded artifact references belong to the author's
 * project-scoped Team chat draft, shared by the dock and embedded Team view.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Bot, CheckIcon, CopyIcon, Paperclip, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { ChatComposer, type ChatComposerHandle, type SuggestedAction } from "@/components/chat/ChatComposer"
import { InputGroupButton } from "@/components/ui/input-group"
import type { ContextChip } from "@/lib/agent/context-chip"
import { composeAgentSend } from "@/lib/agent/compose-send"
import { getTranslatorProfile, profileForPrompt } from "@/lib/translator-profile"
import { composerDraftKey, composerDraftStore, useComposerDraft, type ComposerDraftScope } from "@/lib/agent/composer-drafts"
import { TEAM_CHAT_CONVERSATION } from "@/lib/agent/team-channel"
import { uploadAgentArtifact, ArtifactUploadError } from "@/lib/agent/artifact-upload"
import type { CellData } from "@/hooks/useCells"
import type { TranslationRule } from "@/lib/parsers/types"
import type { ApplyContext } from "@/lib/agent/apply"
import type { AgentProposal, FileCandidate } from "@/lib/agent/protocol"
import { useAgentSession } from "@/lib/agent/session-store"
import { chatTranscript } from "@/lib/agent/transcript"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerEndOnSignal,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { AgentEmptyState } from "./AgentEmptyState"
import { AgentUsageRing } from "./AgentUsageRing"
import type { CreditsDialProps } from "./CreditsDial"
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
  /** Org credit gauge for the composer's usage ring (maintainer+ only;
   *  everyone else sees the latest run's budget %). */
  credits?: CreditsDialProps | null
  /** Current user's project role level (project.syncRole.level). */
  roleLevel: number | null
  /** Current file/cell location — automatically sent as run context. */
  context: { fileId?: string; cellId?: string; lane?: string }
  /** Project's active rules for proposal lint. */
  rules: TranslationRule[]
  /** Live cell lookup from useCells. */
  resolveCell?: (cellId: string) => CellData | undefined
  /** AQU-1630: project's "Allow self-validation" setting, so a prepared
   *  validation of this reader's own line reads as not applicable rather than
   *  failing on Apply. */
  allowSelfValidation?: boolean
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
  /** Contextual dispatches/decisions, inside the shared conversation scroller. */
  conversationPrelude?: ReactNode
}

export function AgentDockView(props: AgentDockViewProps) {
  const draftScope: ComposerDraftScope = {
    owner: props.author, projectId: props.projectId, conversationId: TEAM_CHAT_CONVERSATION,
  }
  return <ScopedAgentDockView key={composerDraftKey(draftScope)} {...props} draftScope={draftScope} />
}

function ScopedAgentDockView({
  draftScope,
  projectId,
  jwt,
  author,
  credits,
  roleLevel,
  context,
  rules,
  resolveCell,
  allowSelfValidation,
  onApplied,
  suggestedActions,
  pendingPrompt,
  onPendingPromptConsumed,
  pendingChip,
  onPendingChipConsumed,
  renderProposalOverride,
  onReviewMemory,
  conversationPrelude,
}: AgentDockViewProps & { draftScope: ComposerDraftScope }) {
  const t = useT()
  const { state, send, stop, startNewChat, noteActivity } = useAgentSession(projectId, author)
  // Bumped on every own-send: the scroller snaps to the end so the sent
  // message (and the reply about to stream) is in view even if the user had
  // scrolled up to read history.
  const [sendSignal, setSendSignal] = useState(0)
  const composerRef = useRef<ChatComposerHandle>(null)
  const draftStore = composerDraftStore(draftScope)
  const { attachments, attachmentError: attachError } = useComposerDraft(draftStore)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Composer attach-file affordance (AQU-AGENT Wave-2). Chosen files are
  // uploaded as project artifacts immediately; the returned {artifactId,
  // fileName} pairs ride the next run request so the harness can load_artifact
  // them into the sandbox. Attachments clear once a prompt is sent.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const handleFilesChosen = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || !jwt) return
      draftStore.setAttachmentError(null)
      setUploading(true)
      try {
        for (const file of Array.from(files)) {
          const uploaded = await uploadAgentArtifact(jwt, projectId, file)
          draftStore.addAttachment({ artifactId: uploaded.artifactId, fileName: uploaded.fileName })
        }
      } catch (err) {
        draftStore.setAttachmentError(
          err instanceof ArtifactUploadError ? err.message : "Could not attach that file. Try again.",
        )
      } finally {
        if (mountedRef.current) setUploading(false)
      }
    },
    [jwt, projectId, draftStore],
  )

  const removeAttachment = useCallback((artifactId: string) => {
    draftStore.removeAttachments([artifactId])
  }, [draftStore])

  const sendPrompt = useCallback(
    (text: string, chips: ContextChip[] = []) => {
      const batch = draftStore.getSnapshot().attachments
      // The dock and embedded Team chat use the same composition contract.
      const options = composeAgentSend({
        text,
        chips,
        jwt,
        projectId,
        context,
        artifacts: batch,
      })
      if (!options) return false
      send(options)
      setSendSignal((s) => s + 1)
      // Attachments belong to the message that carried them — clear after send.
      if (batch.length > 0) draftStore.removeAttachments(batch.map((attachment) => attachment.artifactId))
      return true
    },
    [jwt, send, projectId, context, draftStore],
  )

  // AQU-1468: a file button under the agent's "which file?" question. Sends the
  // choice as a new turn scoped to that file, same as typing the name. Only
  // the newest run's buttons work, and only while nothing is streaming.
  const latestRunId = state.runs[state.runs.length - 1]?.localId
  const chooseFile = useCallback(
    (runLocalId: string, candidate: FileCandidate) => {
      if (!jwt || state.isStreaming || runLocalId !== latestRunId) return
      const text = t("agent.run.useFileMessage", { name: candidate.name })
      const translatorProfile = profileForPrompt(getTranslatorProfile())
      send({
        wire: text,
        display: text,
        jwt,
        request: {
          projectId,
          context: { fileId: candidate.id },
          ...(translatorProfile ? { translatorProfile } : {}),
        },
      })
    },
    [jwt, state.isStreaming, latestRunId, send, projectId, t],
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
  //
  // AQU-1653: "Ask AI" is a fresh question about the passage the reader just
  // selected, so it starts a NEW chat rather than appending to whatever the
  // last conversation was about — safe now that the old chat is saved on the
  // server and reopenable from the chat menu. Two cases keep the current chat:
  // an empty one (there is nothing to start away from) and a streaming one
  // (a new chat aborts the run in flight, which the reader did not ask for).
  useEffect(() => {
    if (!pendingChip) return
    if (state.runs.length > 0 && !state.isStreaming) startNewChat()
    composerRef.current?.insertChip(pendingChip)
    onPendingChipConsumed?.()
    // Deliberately keyed on the chip alone: re-running when runs/isStreaming
    // change would start a second new chat for one "Ask AI".
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {state.runs.length === 0 && !conversationPrelude ? (
        jwt ? (
          <AgentEmptyState
            projectId={projectId}
            onPromptSelect={(text) => composerRef.current?.insertText(text)}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-3 text-center text-muted-foreground">
            <Bot className="h-5 w-5" />
            <p className="text-xs">{t("agent.dock.signInNotice")}</p>
          </div>
        )
      ) : (
        // Stick-to-bottom (2026-08-31 review): follow new content while the
        // reader is at the bottom; any upward scroll breaks the follow and the
        // ArrowDown button re-engages it. scrollAnchor is deliberately OFF —
        // anchoring the sent message to the top would hold the viewport still
        // while tool activity streams below the fold.
        <MessageScrollerProvider autoScroll scrollEdgeThreshold={64}>
          <MessageScroller className="flex-1">
            <MessageScrollerEndOnSignal signal={sendSignal} />
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-5 px-4 pb-3 pt-4">
                {conversationPrelude}
                {state.runs.map((run, runIndex) => (
                  <MessageScrollerItem
                    key={run.localId}
                    messageId={run.localId}
                    className="border-b border-border/40 pb-4 last:border-b-0"
                  >
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
                            allowSelfValidation={allowSelfValidation}
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
                      onChangesetApplied={onApplied}
                      onChooseFile={(candidate) => chooseFile(run.localId, candidate)}
                      fileChoiceEnabled={
                        Boolean(jwt) && !state.isStreaming && run.localId === latestRunId
                      }
                      onSuggestionSend={
                        runIndex === state.runs.length - 1 && jwt
                          ? (text) => sendPrompt(text)
                          : undefined
                      }
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
            <MessageScrollerButton className="shadow-sm" />
            {state.runs.length > 0 && <CopyChatButton text={() => chatTranscript(state.runs)} />}
          </MessageScroller>
        </MessageScrollerProvider>
      )}

      <ChatComposer
        ref={composerRef}
        draftScope={draftScope}
        isStreaming={state.isStreaming}
        isConfigured={Boolean(jwt)}
        onSend={({ text, chips }) => sendPrompt(text, chips)}
        onStop={stop}
        compact
        suggestedActions={suggestedActions}
        queueWhileStreaming
        placeholder={t("agent.dock.composerPlaceholder")}
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
                        aria-label={t("agent.dock.removeAttachmentAriaLabel", { fileName: a.fileName })}
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
              className="rounded-full"
              disabled={!jwt || uploading}
              aria-label={t("agent.dock.attachFileAriaLabel")}
              title={t("agent.dock.attachFileTitle")}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? <Spinner /> : <Paperclip />}
            </InputGroupButton>
            <AgentUsageRing credits={credits} runs={state.runs} isStreaming={state.isStreaming} />
          </>
        }
      />
    </div>
  )
}

/** Copies the whole conversation as plain text. Hover-revealed on pointer
 *  devices (like the step inspector), always visible on touch. */
function CopyChatButton({ text }: { text: () => string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const label = t(copied ? "agent.dock.copiedChat" : "agent.dock.copyChat")
  return (
    <AppTooltip content={label} side="left" delay={150}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        data-testid="agent-copy-chat"
        className="absolute right-2 top-2 z-10 bg-background/80 shadow-sm [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/message-scroller:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100"
        onClick={() => {
          void navigator.clipboard?.writeText(text()).then(() => setCopied(true), () => {})
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </AppTooltip>
  )
}
