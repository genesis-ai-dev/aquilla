import { NavLink } from "react-router-dom"
import { BookOpen, Laptop, type LucideIcon } from "lucide-react"
import { OrgSwitcher } from "@/components/org/OrgSwitcher"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { useT } from "@/lib/i18n/I18nProvider"
import { PARATEXT_PATH, THIS_COMPUTER_PATH } from "./routes"

const link = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-normal ${isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`

function NavIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4 shrink-0" aria-hidden />
}

/** Desktop-only workspace chrome: the org switcher stays on top so the user
 *  can step back into an organization; the nav is what lives on this device. */
export function ThisComputerSidebar() {
  const t = useT()
  return (
    <div className="flex h-full min-w-0 flex-col gap-1 overflow-hidden p-2">
      <div data-tour="org-switcher">
        <OrgSwitcher />
      </div>
      <nav className="mt-2 flex flex-1 flex-col gap-0.5" aria-label={t("paratextBridge.thisComputer.title")}>
        <NavLink to={THIS_COMPUTER_PATH} end className={link}>
          <NavIcon icon={Laptop} />
          {t("paratextBridge.thisComputer.title")}
        </NavLink>
        <NavLink to={PARATEXT_PATH} className={link}>
          <NavIcon icon={BookOpen} />
          {t("paratextBridge.title")}
        </NavLink>
      </nav>
      <div className="mt-auto pt-2" data-tour="account-switcher">
        <div className="min-w-0">
          <AccountSwitcher variant="sidebar" />
        </div>
      </div>
    </div>
  )
}
