/**
 * Puts a batch run's live status in the same bottom-right toast stack as
 * every other notice. The toast stays up (timeout 0) until the run ends or
 * the person closes it. Closing a toast the effect itself replaced does not
 * run the close handler, so handing from "running" to "finished" does not
 * also cancel the run.
 */
import { useEffect, useInsertionEffect, useRef, type ReactNode } from "react"
import { toast } from "@/components/ui/toast"

export function useProgressToast({
  id,
  active,
  type,
  body,
  onClose,
}: {
  id: string
  active: boolean
  type: string
  body: ReactNode
  onClose?: () => void
}) {
  const onCloseRef = useRef(onClose)
  const bodyRef = useRef(body)
  // Written before the toast effect, and never during render: a close click
  // and the first paint both see the latest handler and body.
  useInsertionEffect(() => {
    onCloseRef.current = onClose
    bodyRef.current = body
  })

  useEffect(() => {
    if (!active) return
    let replaced = false
    toast.add({
      id,
      timeout: 0,
      type,
      data: { body: bodyRef.current },
      onClose: () => {
        if (replaced) return
        onCloseRef.current?.()
      },
    })
    return () => {
      replaced = true
      toast.close(id)
    }
  }, [active, id, type])

  useEffect(() => {
    if (!active) return
    toast.update(id, { type, data: { body } })
  }, [active, id, type, body])
}
