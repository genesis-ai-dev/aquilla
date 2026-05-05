import { useQuery } from "@tanstack/react-query"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"

export interface CellValidator {
  editEventId: string
  username: string
  isActive: boolean
  decidedTs: number
}

export interface UseCellValidatorsOptions {
  enabled: boolean
  fileId: string | null
  cellId: string | null
  getTokenForFile: (fileId: string) => Promise<string | null>
}

export function useCellValidators(opts: UseCellValidatorsOptions): {
  validators: CellValidator[]
  isLoading: boolean
  isError: boolean
} {
  const { enabled, fileId, cellId, getTokenForFile } = opts

  const { data, isLoading, isError } = useQuery<CellValidator[]>({
    queryKey: ["cell-validators", fileId, cellId],
    enabled: enabled && !!fileId && !!cellId,
    staleTime: 5_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      const token = await getTokenForFile(fileId!)
      if (!token) {
        throw new Error("no-token")
      }
      const url = new URL(`${syncWorkerHttpOrigin()}/cell-validators`)
      url.searchParams.set("fileId", fileId!)
      url.searchParams.set("cellId", cellId!)
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const body: { validators: CellValidator[] } = await res.json()
      // Server returns by decided_ts DESC; pass through as-is.
      return body.validators
    },
  })

  return {
    validators: data ?? [],
    isLoading,
    isError,
  }
}
