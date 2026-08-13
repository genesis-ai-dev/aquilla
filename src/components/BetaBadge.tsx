import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Discord } from "@/components/icons/Discord"
import { useT } from "@/lib/i18n/I18nProvider"

const BETA_ENABLED = import.meta.env.VITE_BETA_FLAG === "1"

export function BetaBadge() {
  const t = useT()
  if (!BETA_ENABLED) return null

  return (
    <Dialog>
      <DialogTrigger
        render={
          <button type="button" className="inline-flex items-center">
            <Badge>{t("nav.beta.badge")}</Badge>
          </button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("nav.beta.title")}</DialogTitle>
          <DialogDescription>{t("nav.beta.description")}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li>{t("nav.beta.pointEvolving")}</li>
          <li>{t("nav.beta.pointFeatures")}</li>
          <li>{t("nav.beta.pointFeedback")}</li>
        </ul>
        <DialogFooter showCloseButton>
          <Button
            variant="outline"
            nativeButton={false}
            render={<a href="https://discord.gg/T2EndwXe4W" target="_blank" rel="noopener noreferrer" />}
          >
            <Discord className="mr-1.5 h-4 w-4" />
            {t("nav.beta.joinDiscord")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
