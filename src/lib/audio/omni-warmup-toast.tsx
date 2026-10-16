// The toasts the zero-shot path shows: the cold-start wait, its timeout, the
// missing-examples offer, the org-disabled fallback, and the batch confirm.

import { IntelligentProgress } from "@/components/IntelligentProgress"
import { toast } from "@/components/ui/toast"
import { t } from "@/lib/i18n/standalone"
import type { WarmupTimeoutChoice, WarmupUi } from "./omni-warmup"

const WARMUP_TOAST_ID = "omni-zs-warmup"

function progress(pending: boolean) {
  return (
    <IntelligentProgress
      pending={pending}
      label={t("settings.transcription.zeroShot.warmupTitle")}
      onSettled={() => { if (!pending) toast.close(WARMUP_TOAST_ID) }}
      className="mt-2"
    />
  )
}

export const toastWarmupUi: WarmupUi = {
  starting() {
    toast.add({
      id: WARMUP_TOAST_ID,
      type: "loading",
      timeout: 0,
      title: t("settings.transcription.zeroShot.warmupTitle"),
      description: progress(true),
    })
  },
  ready() {
    // The bar plays through to full, then IntelligentProgress closes the toast.
    toast.update(WARMUP_TOAST_ID, { description: progress(false) })
  },
  timedOut() {
    return new Promise<WarmupTimeoutChoice>((resolve) => {
      let settled = false
      const settle = (choice: WarmupTimeoutChoice) => {
        if (settled) return
        settled = true
        resolve(choice)
      }
      toast.close(WARMUP_TOAST_ID)
      toast.add({
        id: `${WARMUP_TOAST_ID}:timeout`,
        type: "error",
        timeout: 0,
        title: t("settings.transcription.zeroShot.warmupTimeout"),
        actionProps: {
          children: t("common.retry"),
          onClick: () => {
            settle("retry")
            toast.close(`${WARMUP_TOAST_ID}:timeout`)
          },
        },
        data: {
          secondaryAction: {
            label: t("settings.transcription.zeroShot.useAutomatic"),
            onClick: () => settle("auto"),
          },
        },
        onClose: () => settle("dismiss"),
      })
    })
  },
}

/**
 * ZS has no examples to learn from. Offer Omnilingual standard (CTC) for the
 * run instead; closing the toast leaves the take untranscribed.
 */
export function promptZeroShotNoExamples(): Promise<"omni-ctc" | "cancel"> {
  const id = "omni-zs-no-examples"
  return new Promise((resolve) => {
    let settled = false
    const settle = (choice: "omni-ctc" | "cancel") => {
      if (settled) return
      settled = true
      resolve(choice)
    }
    toast.add({
      id,
      type: "info",
      timeout: 0,
      title: t("settings.transcription.zeroShot.noExamples"),
      actionProps: {
        children: t("settings.transcription.zeroShot.useOmniStandard"),
        onClick: () => {
          settle("omni-ctc")
          toast.close(id)
        },
      },
      onClose: () => settle("cancel"),
    })
  })
}

/** The org turned ZS off; the run went to the automatic model. */
export function toastZeroShotDisabled(): void {
  toast.add({ type: "info", title: t("settings.transcription.zeroShot.disabledByOrg") })
}

/**
 * Before a zero-shot batch: what it should cost, and the choice to run it,
 * run it with the automatic model instead, or not at all (closing the toast).
 */
export function confirmZeroShotBatch(args: { count: number; costLine: string }): Promise<"zs" | "auto" | "cancel"> {
  const id = "omni-zs-batch-confirm"
  return new Promise((resolve) => {
    let settled = false
    const settle = (choice: "zs" | "auto" | "cancel") => {
      if (settled) return
      settled = true
      resolve(choice)
    }
    toast.add({
      id,
      timeout: 0,
      title: t("settings.transcription.zeroShot.batchTitle", { count: args.count }),
      description: args.costLine,
      actionProps: {
        children: t("settings.transcription.zeroShot.batchConfirm"),
        onClick: () => {
          settle("zs")
          toast.close(id)
        },
      },
      data: {
        secondaryAction: {
          label: t("settings.transcription.zeroShot.useAutomatic"),
          onClick: () => settle("auto"),
        },
      },
      onClose: () => settle("cancel"),
    })
  })
}
