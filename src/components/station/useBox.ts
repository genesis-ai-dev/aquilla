import { useEffect, useState } from "react"

/** An element's size, kept current (the lane draws one peak per 2 px). */
export function useBox(el: HTMLElement | null): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      setBox((b) => (Math.round(r.width) === b.width && Math.round(r.height) === b.height ? b : { width: Math.round(r.width), height: Math.round(r.height) }))
    }
    read()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return box
}
