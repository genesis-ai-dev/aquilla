/**
 * Wires one mounted tool frame to the project: the live data source, the
 * bridge host, the permission gate (standing grant → inline prompt), live
 * cells.changed pushes and theme forwarding.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { toast } from "@/components/ui/toast"
import { useOutbox } from "@/context/OutboxContext"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import type { FrontierSession } from "@/lib/frontier/types"
import { subscribeAppliedEvents } from "@/lib/sync/outbox-flush"
import { subscribeProjectApplied, type ProjectAppliedFrame } from "@/lib/tools/project-applied-bus"
import { BridgeError, createBridgeHost, type BridgeHost, type ToolErrorReport } from "@/lib/tools/host-bridge"
import { createToolHandlers } from "@/lib/tools/host-handlers"
import { LiveToolData } from "@/lib/tools/live-data"
import { METHOD_SCOPES, applyPromptAnswer, decideScope, type PromptAnswer } from "@/lib/tools/permissions"
import { readThemeVars } from "@/lib/tools/srcdoc"
import { setToolGrant, type ToolDetail } from "@/lib/tools/tools-api"
import type { ToolScope } from "../../../shared/tools/manifest"
import type { PendingPrompt } from "./PermissionPrompt"

export interface UseToolHostArgs {
  frameRef: RefObject<HTMLIFrameElement | null>
  projectId: string
  tool: ToolDetail
  session: FrontierSession
  roleLevel: number | null
  onGrantChange?: (scopes: ToolScope[]) => void
}

export interface ToolHostState {
  prompt: PendingPrompt | null
  errors: ToolErrorReport[]
  clearErrors: () => void
  /** Set when the tool called a removed bridge API. */
  removedApi: string | null
  /** Messages the tool left with aquilla.tell (newest last). */
  messages: string[]
  dismissMessage: (index: number) => void
  ready: boolean
}

export function useToolHost({ frameRef, projectId, tool, session, roleLevel, onGrantChange }: UseToolHostArgs): ToolHostState {
  const { flushNow } = useOutbox()
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null)
  const [errors, setErrors] = useState<ToolErrorReport[]>([])
  const [ready, setReady] = useState(false)
  const [removedApi, setRemovedApi] = useState<string | null>(null)
  const [messages, setMessages] = useState<string[]>([])

  const standingRef = useRef<Set<ToolScope>>(new Set(tool.grantedScopes))
  const deniedRef = useRef<Set<ToolScope>>(new Set())
  const roleRef = useRef(roleLevel)
  const flushRef = useRef(flushNow)
  const grantCbRef = useRef(onGrantChange)
  const hostRef = useRef<BridgeHost | null>(null)
  // Declared scopes via a ref so a refetched tool object (same version) does
  // not re-create the bridge mid-session.
  const declaredRef = useRef(tool.manifest.scopes)
  useEffect(() => {
    roleRef.current = roleLevel
    flushRef.current = flushNow
    grantCbRef.current = onGrantChange
    declaredRef.current = tool.manifest.scopes
  }, [roleLevel, flushNow, onGrantChange, tool.manifest.scopes])
  // Prompts are serialized: a tool firing three gated calls at once gets one
  // prompt at a time, and a later call reuses an "always" answer.
  const promptChain = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    standingRef.current = new Set(tool.grantedScopes)
  }, [tool.grantedScopes])

  const ask = useCallback(
    (scope: ToolScope): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        const decision = decideScope(scope, {
          standing: standingRef.current,
          deniedThisSession: deniedRef.current,
          roleLevel: roleRef.current,
        })
        if (decision.kind === "allow") return true
        if (decision.kind === "deny") return false
        const answer = await new Promise<PromptAnswer>((resolve) => {
          setPrompt({ scope, declared: declaredRef.current.includes(scope), answer: resolve })
        })
        setPrompt(null)
        const outcome = applyPromptAnswer(scope, answer, standingRef.current)
        if (outcome.deny) deniedRef.current.add(outcome.deny)
        if (outcome.nextStanding) {
          // The server only stores declared scopes; an undeclared "always"
          // degrades to a session grant.
          const declared = outcome.nextStanding.filter((s) => declaredRef.current.includes(s))
          standingRef.current = new Set(outcome.nextStanding)
          try {
            const saved = await setToolGrant(session.jwt, projectId, tool.id, declared)
            grantCbRef.current?.(saved)
          } catch (err) {
            console.warn("[tools] saving the standing grant failed:", err)
          }
        }
        return outcome.allowed
      }
      const next = promptChain.current.then(run, run)
      promptChain.current = next.catch(() => undefined)
      return next
    },
    [projectId, session.jwt, tool.id],
  )

  const toolName = tool.name
  const toolId = tool.id
  const toolVersion = tool.currentVersion
  const codeHash = tool.codeHash

  useEffect(() => {
    const data = new LiveToolData({
      projectId,
      sessionJwt: session.jwt,
      author: session.username,
      toolOrigin: { origin: "tool", toolId, version: toolVersion, codeHash },
      tokenFor: makeAudioSyncTokenFetcher(() => session),
      flush: () => flushRef.current(),
      notify: (message) => toast.add({ title: toolName, description: message }),
      tell: (message) => setMessages((prev) => [...prev.slice(-4), message]),
      grantedScopes: () => [...standingRef.current],
      requestScope: (scope) => ask(scope),
      storageKey: `aquilla.tools.storage.v1:${session.username}:${projectId}:${toolId}`,
    })
    const host = createBridgeHost({
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
      handlers: createToolHandlers(data),
      authorize: async (method) => {
        const scope = METHOD_SCOPES[method]
        if (!scope) return
        if (!(await ask(scope))) throw new BridgeError("permission_denied", `${scope} was not allowed`)
      },
      onReady: () => setReady(true),
      onApiRemoved: (_method, message) => setRemovedApi(message),
      onToolError: (err) => setErrors((prev) => [...prev.slice(-4), err]),
    })
    hostRef.current = host
    const stop = host.listen()

    // Live push: after any applied write to a file the tool has listed, drop
    // the cached read and tell the tool which cells changed.
    let timer: ReturnType<typeof setTimeout> | null = null
    const pending = new Map<string, Set<string>>()
    const onFrames = (frames: readonly ProjectAppliedFrame[]) => {
      for (const f of frames) {
        // Every file of this project: the data source may have been re-created
        // (new grant, new version) since the tool listed its files, and tools
        // filter by fileId themselves.
        if (f.project !== projectId || !f.file) continue
        const set = pending.get(f.file) ?? new Set<string>()
        if (f.cell) set.add(f.cell)
        pending.set(f.file, set)
      }
      if (pending.size === 0 || timer) return
      timer = setTimeout(() => {
        timer = null
        for (const [fileId, cells] of pending) {
          data.invalidate(fileId)
          host.push({ type: "cells.changed", fileId, cellIds: [...cells] })
        }
        pending.clear()
      }, 150)
    }
    // Our own flush acks, plus everyone's writes from the project WebSocket.
    const unsubscribeOwn = subscribeAppliedEvents((frames) => onFrames(frames))
    const unsubscribeRemote = subscribeProjectApplied((frame) => onFrames([frame]))

    return () => {
      stop()
      unsubscribeOwn()
      unsubscribeRemote()
      if (timer) clearTimeout(timer)
      hostRef.current = null
    }
  }, [projectId, session, toolId, toolVersion, codeHash, toolName, ask, frameRef])

  // Theme: forward the app's CSS variables when light/dark flips.
  useEffect(() => {
    const observer = new MutationObserver(() => hostRef.current?.push({ type: "theme", vars: readThemeVars() }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] })
    return () => observer.disconnect()
  }, [])

  return {
    prompt,
    errors,
    clearErrors: () => setErrors([]),
    ready,
    removedApi,
    messages,
    dismissMessage: (index: number) => setMessages((prev) => prev.filter((_, i) => i !== index)),
  }
}
