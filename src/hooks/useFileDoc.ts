import { useEffect, useState } from "react"
import * as Y from "yjs"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"

export function useFileDoc(fileId: string | null) {
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!fileId) {
      setDoc(null)
      setLoading(false)
      return
    }

    setLoading(true)
    const handle = loadFileDoc(fileId)

    function onSynced() {
      setDoc(handle.doc)
      setLoading(false)
    }

    if (handle.persistence.synced) {
      onSynced()
    } else {
      handle.persistence.once("synced", onSynced)
    }

    return () => {
      destroyFileDoc(handle)
      setDoc(null)
    }
  }, [fileId])

  return { doc, loading }
}
