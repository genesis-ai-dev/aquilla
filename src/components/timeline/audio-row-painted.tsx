import { createContext, useContext, useEffect } from "react"

/**
 * The Target audio row tells the workspace it has committed, so the walks
 * that read every line of the file (progress, health, the text table) run
 * on the following frame.
 */
export const AudioRowPaintedContext = createContext<(() => void) | null>(null)

export function useNotifyAudioRowPainted(): void {
  const mark = useContext(AudioRowPaintedContext)
  useEffect(() => {
    if (!mark) return
    // Tests flush effects inside act() and expect the following frame's
    // work to be present. The browser waits a task so the row can paint
    // before that work starts.
    if (import.meta.env.MODE === "test") {
      mark()
      return
    }
    const id = window.setTimeout(mark, 0)
    return () => window.clearTimeout(id)
  }, [mark])
}
