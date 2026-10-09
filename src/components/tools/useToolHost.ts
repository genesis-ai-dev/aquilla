/**
 * Wires one mounted tool frame to the project: the live data source, the
 * bridge host, the permission gate (standing grant → inline prompt), live
 * cells.changed pushes and theme forwarding.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react"
import { toast } from "@/components/ui/toast"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { useOutbox } from "@/context/OutboxContext"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import type { FrontierSession } from "@/lib/frontier/types"
import { subscribeAppliedEvents } from "@/lib/sync/outbox-flush"
import { subscribeProjectApplied, type ProjectAppliedFrame } from "@/lib/tools/project-applied-bus"
import { BridgeError, createBridgeHost, type BridgeHost, type ToolErrorReport } from "@/lib/tools/host-bridge"
import { createToolHandlers } from "@/lib/tools/host-handlers"
import { LiveToolData, type ToolHostServices } from "@/lib/tools/live-data"
import { dispatchHostKey } from "@/lib/tools/host-keys"
import { METHOD_SCOPES, applyPromptAnswer, decideScope, type PromptAnswer } from "@/lib/tools/permissions"
import { readThemeVars } from "@/lib/tools/srcdoc"
import { loadFrameFonts } from "@/lib/tools/frame-fonts"
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
  /** apiRev 2: workspace services for this mount (editor mounts). */
  services?: ToolHostServices
  /** apiRev 2: a cell the host wants the extension to show (deep link). */
  revealCellId?: string | null
  /** apiRev 3: lets the host push events to this frame (editor commands). */
  controlRef?: MutableRefObject<ToolFrameControl | null>
  /** apiRev 3: size of the host chrome drawn over the frame's top-right. */
  chrome?: { trailingWidth: number; trailingHeight: number } | null
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
  /** apiRev 3: the frame loaded but shows nothing (render.check). */
  blank: boolean
}

/** Host → frame commands for a mounted tool (apiRev 3). */
export interface ToolFrameControl {
  push: (event: { type: string } & Record<string, unknown>) => void
}

export function useToolHost({ frameRef, projectId, tool, session, roleLevel, onGrantChange, services, revealCellId, chrome, controlRef }: UseToolHostArgs): ToolHostState {
  const { flushNow } = useOutbox()
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null)
  const [errors, setErrors] = useState<ToolErrorReport[]>([])
  const [ready, setReady] = useState(false)
  const [blank, setBlank] = useState(false)
  const [removedApi, setRemovedApi] = useState<string | null>(null)
  const [messages, setMessages] = useState<string[]>([])

  const standingRef = useRef<Set<ToolScope>>(new Set(tool.grantedScopes))
  const deniedRef = useRef<Set<ToolScope>>(new Set())
  const roleRef = useRef(roleLevel)
  const flushRef = useRef(flushNow)
  const grantCbRef = useRef(onGrantChange)
  const hostRef = useRef<BridgeHost | null>(null)
  const { locale } = useI18n()
  const localeRef = useRef(locale)
  useEffect(() => {
    localeRef.current = locale
  }, [locale])
  const dataRef = useRef<LiveToolData | null>(null)
  const servicesRef = useRef<ToolHostServices | undefined>(services)
  useEffect(() => {
    servicesRef.current = services
  }, [services])
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
      services: () => servicesRef.current ?? {},
      hostKey: (key) => dispatchHostKey(key),
      locale: () => localeRef.current,
    })
    const warmFile = servicesRef.current?.fileId
    // Editor mounts read the workspace's store: nothing to warm.
    if (warmFile && !servicesRef.current?.editor) data.warm(warmFile)
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
      onRender: (report) => setBlank(report.empty),
    })
    hostRef.current = host
    dataRef.current = data
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
          data.invalidateCells(fileId, [...cells])
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
      dataRef.current = null
    }
  }, [projectId, session, toolId, toolVersion, codeHash, toolName, ask, frameRef])

  // apiRev 2 live pushes from workspace services: focus locks and comments.
  const lockHolders = services?.lockHolders
  const commentCounts = services?.commentCounts
  const boundFile = services?.fileId
  useEffect(() => {
    if (!ready || !lockHolders) return
    const holders: Record<string, { username: string }> = {}
    for (const [key, username] of lockHolders) holders[key.split("@lane:")[0]] = { username }
    hostRef.current?.push({ type: "presence.changed", fileId: boundFile ?? null, holders })
  }, [ready, lockHolders, boundFile])
  useEffect(() => {
    if (!ready || !commentCounts) return
    hostRef.current?.push({ type: "comments.changed", fileId: boundFile ?? null })
  }, [ready, commentCounts, boundFile])
  // apiRev 3: the editor pipeline's live state. Each push names what changed;
  // the extension re-reads through the bridge (scope-gated as usual).
  const editor = services?.editor
  const editorStore = editor?.store
  useEffect(() => {
    if (!ready || !editorStore || !boundFile) return
    // Store bumps (own optimistic edits, AI drafts landing, remote edits via
    // the project socket, revalidation): name exactly the cells the extension
    // has read whose version moved. List changes (insert/remove/hide) re-page.
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      const data = dataRef.current
      const current = servicesRef.current?.editor
      if (!data || !current) return
      const changed = data.editor.changedSinceSeen(current)
      if (changed.length > 0) hostRef.current?.push({ type: "cells.changed", fileId: boundFile, cellIds: changed })
    }
    const unsubAll = editorStore.subscribeAll(() => {
      if (!timer) timer = setTimeout(flush, 60)
    })
    // Only a real change to the cell list (insert, remove, hide, reorder) —
    // the list version also moves on edits that leave the order alone.
    let lastIds = editorStore.getCellIds().join("\u0001")
    const unsubList = editorStore.subscribeList(() => {
      const ids = editorStore.getCellIds().join("\u0001")
      if (ids === lastIds) return
      lastIds = ids
      hostRef.current?.push({ type: "cells.structure", fileId: boundFile })
    })
    return () => {
      unsubAll()
      unsubList()
      if (timer) clearTimeout(timer)
    }
  }, [ready, editorStore, boundFile])
  const editorSignals = editor?.signals
  const editorPeers = editor?.peers
  const editorSelection = editor?.selection
  const editorConfig = editor?.config
  const editorBts = editor?.backtranslations
  const editorLoading = editor?.storeLoading
  const editorPericopes = editor?.pericopes
  // apiRev 4: audio takes, autopilot drafts and smart edits changed.
  const rev4Audio = editor?.rev4Versions?.audio
  const rev4Contextual = editor?.rev4Versions?.contextual
  const rev4Smart = editor?.rev4Versions?.smartEdits
  const rev4Examples = editor?.rev4Versions?.examples
  useEffect(() => {
    if (ready && rev4Examples !== undefined) hostRef.current?.push({ type: "examples.changed", fileId: boundFile ?? null })
  }, [ready, rev4Examples, boundFile])
  useEffect(() => {
    if (ready && rev4Audio !== undefined) hostRef.current?.push({ type: "audio.changed", fileId: boundFile ?? null })
  }, [ready, rev4Audio, boundFile])
  useEffect(() => {
    if (ready && rev4Contextual !== undefined) hostRef.current?.push({ type: "contextual.changed", fileId: boundFile ?? null })
  }, [ready, rev4Contextual, boundFile])
  useEffect(() => {
    if (ready && rev4Smart !== undefined) hostRef.current?.push({ type: "smartedits.changed", fileId: boundFile ?? null })
  }, [ready, rev4Smart, boundFile])
  useEffect(() => {
    if (ready && editorPericopes) hostRef.current?.push({ type: "pericopes.changed", fileId: boundFile ?? null })
  }, [ready, editorPericopes, boundFile])
  useEffect(() => {
    if (ready && editorSignals) hostRef.current?.push({ type: "signals.changed", fileId: boundFile ?? null })
  }, [ready, editorSignals, boundFile])
  useEffect(() => {
    if (ready && editorPeers) hostRef.current?.push({ type: "presence.peers", fileId: boundFile ?? null, peers: editorPeers })
  }, [ready, editorPeers, boundFile])
  useEffect(() => {
    if (ready && editorSelection) hostRef.current?.push({ type: "selection.changed", fileId: boundFile ?? null, cellIds: [...editorSelection] })
  }, [ready, editorSelection, boundFile])
  useEffect(() => {
    if (ready && editorConfig) hostRef.current?.push({ type: "config.changed", fileId: boundFile ?? null })
  }, [ready, editorConfig, boundFile])
  useEffect(() => {
    if (ready && editorBts) hostRef.current?.push({ type: "backtranslation.changed", fileId: boundFile ?? null })
  }, [ready, editorBts, boundFile])
  useEffect(() => {
    if (ready && editorLoading === false) hostRef.current?.push({ type: "cells.loaded", fileId: boundFile ?? null })
  }, [ready, editorLoading, boundFile])
  useEffect(() => {
    if (!controlRef) return
    controlRef.current = ready ? { push: (event) => hostRef.current?.push(event) } : null
    return () => {
      controlRef.current = null
    }
  }, [controlRef, ready])
  const chromeWidth = chrome?.trailingWidth ?? 0
  const chromeHeight = chrome?.trailingHeight ?? 0
  useEffect(() => {
    if (ready) hostRef.current?.push({ type: "editor.chrome", trailingWidth: chromeWidth, trailingHeight: chromeHeight })
  }, [ready, chromeWidth, chromeHeight])
  // Deep links (search result, navigation, ?cellId=): ask the extension to
  // show the cell, and hand it keyboard focus.
  useEffect(() => {
    if (!ready || !revealCellId) return
    hostRef.current?.push({ type: "editor.reveal", fileId: boundFile ?? null, cellId: revealCellId })
    frameRef.current?.contentWindow?.focus()
  }, [ready, revealCellId, boundFile, frameRef])

  // apiRev 3: catch a mount that loads but draws nothing (asked twice: a
  // slow first load is not "blank").
  useEffect(() => {
    if (!ready) return
    const a = setTimeout(() => hostRef.current?.push({ type: "render.check" }), 2500)
    const b = setTimeout(() => hostRef.current?.push({ type: "render.check" }), 8000)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
  }, [ready])
  // apiRev 3: the app font's bytes, once the frame is listening.
  useEffect(() => {
    if (!ready) return
    let alive = true
    loadFrameFonts()
      .then((fonts) => {
        if (alive) hostRef.current?.push({ type: "fonts", fonts })
      })
      .catch((err) => console.warn("[tools] app font for the frame failed:", err))
    return () => {
      alive = false
    }
  }, [ready])
  // Theme: forward the app's CSS variables when light/dark flips.
  useEffect(() => {
    const observer = new MutationObserver(() => hostRef.current?.push({ type: "theme", vars: readThemeVars() }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] })
    // The app's breakpoints follow its viewport: re-send on resize.
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => hostRef.current?.push({ type: "theme", vars: readThemeVars() }))
    }
    window.addEventListener("resize", onResize)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", onResize)
      cancelAnimationFrame(raf)
    }
  }, [])

  return {
    prompt,
    errors,
    clearErrors: () => setErrors([]),
    ready,
    blank,
    removedApi,
    messages,
    dismissMessage: (index: number) => setMessages((prev) => prev.filter((_, i) => i !== index)),
  }
}
