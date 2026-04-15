import { useEffect, useRef, useState } from "react"
import { streamAllProjects } from "@/lib/frontier/api"
import type { FrontierSession, GitlabProject } from "@/lib/frontier/types"

interface State {
  projects: GitlabProject[]
  loading: boolean
  error: string | null
}

export function useStreamingFrontierProjects(session: FrontierSession | null) {
  const [state, setState] = useState<State>({ projects: [], loading: false, error: null })
  const bufferRef = useRef<GitlabProject[]>([])
  const flushRef = useRef<number | null>(null)

  useEffect(() => {
    if (!session) {
      setState({ projects: [], loading: false, error: null })
      return
    }
    const controller = new AbortController()
    bufferRef.current = []
    setState({ projects: [], loading: true, error: null })

    function scheduleFlush() {
      if (flushRef.current != null) return
      flushRef.current = window.setTimeout(() => {
        flushRef.current = null
        if (bufferRef.current.length === 0) return
        const incoming = bufferRef.current
        bufferRef.current = []
        setState(s => ({ ...s, projects: [...s.projects, ...incoming] }))
      }, 80)
    }

    streamAllProjects(session, (p) => {
      bufferRef.current.push(p)
      scheduleFlush()
    }, { signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return
        if (bufferRef.current.length) {
          const incoming = bufferRef.current
          bufferRef.current = []
          setState(s => ({ ...s, projects: [...s.projects, ...incoming], loading: false }))
        } else {
          setState(s => ({ ...s, loading: false }))
        }
      })
      .catch(err => {
        if (controller.signal.aborted) return
        setState(s => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }))
      })

    return () => {
      controller.abort()
      if (flushRef.current != null) {
        window.clearTimeout(flushRef.current)
        flushRef.current = null
      }
    }
  }, [session])

  return state
}
