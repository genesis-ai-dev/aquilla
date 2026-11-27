import { toast } from "@/components/ui/toast"

/**
 * The stuck-outbox error for batch validate, Draft AI text, and Draft books.
 * `timeout: 0` keeps it up until the reader closes it. The wait is already a
 * minute, so a notice that fades on its own is easy to miss.
 */
export function showBatchSyncTimeoutToast(title: string, existingId: string | null): void {
  const notice = { type: "error" as const, title, timeout: 0 }
  if (existingId) {
    toast.update(existingId, notice)
    return
  }
  toast.add(notice)
}
