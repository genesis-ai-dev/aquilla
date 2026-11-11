import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useI18n } from "@/lib/i18n/I18nProvider"

/**
 * AQU-2358 — the warning shown before an add or an invite that grants no
 * language lane at all.
 *
 * Granting no lanes is a legitimate choice (the person sees the project and
 * its source text, and no translation), but it is also what an unticked form
 * looks like, so every add/invite surface asks once before saving. "Go back
 * and choose lanes" is the default action — the mistake is the likelier
 * reading — and proceeding is the secondary one. Neither button is the
 * dialog's Close primitive: the caller owns `open`, so dismissing by Escape or
 * the backdrop goes back rather than ambiguously doing both.
 */
export function NoLaneAccessConfirm({
  open,
  kind,
  onBack,
  onProceed,
}: {
  open: boolean
  /** An invite link or emailed invite reads "the recipient"; an add does not. */
  kind: "invite" | "add"
  onBack: () => void
  onProceed: () => void
}) {
  const { t } = useI18n()
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onBack()
      }}
    >
      <AlertDialogContent data-testid="no-lanes-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("projectSettings.share.noLanesConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {kind === "invite"
              ? t("projectSettings.share.noLanesConfirmInvite")
              : t("projectSettings.share.noLanesConfirmAdd")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            data-testid="no-lanes-confirm-proceed"
            variant="outline"
            onClick={onProceed}
          >
            {t("projectSettings.share.noLanesConfirmProceed")}
          </AlertDialogAction>
          <AlertDialogAction data-testid="no-lanes-confirm-back" onClick={onBack}>
            {t("projectSettings.share.noLanesConfirmBack")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
