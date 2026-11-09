import { Fragment } from "react"
import { Link } from "react-router-dom"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { useT } from "@/lib/i18n/I18nProvider"
import { THIS_COMPUTER_PATH } from "./routes"

export interface ThisComputerCrumb { label: string; to?: string }

/** `This computer › …trail`. The last segment is the current page. With no
 *  trail, "This computer" itself is current. */
export function ThisComputerBreadcrumb({ trail = [] }: { trail?: ThisComputerCrumb[] }) {
  const t = useT()
  const labelClass = "block shrink-0 whitespace-nowrap rounded-md px-1.5 py-1"
  const crumbs: ThisComputerCrumb[] = [{ label: t("paratextBridge.thisComputer.title"), to: THIS_COMPUTER_PATH }, ...trail]
  const last = crumbs.length - 1
  return (
    <Breadcrumb className="min-w-0 overflow-x-auto">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((c, i) => (
          <Fragment key={`${c.label}-${i}`}>
            {i > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem>
              {i === last || !c.to ? (
                <BreadcrumbPage className={labelClass}>{c.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink className={`${labelClass} hover:bg-accent hover:text-accent-foreground`} render={<Link to={c.to} />}>
                  {c.label}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
