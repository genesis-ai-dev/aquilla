import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon } from "lucide-react"
import { useThemeMode } from "@/branding/ThemeMode"
import { BarSpinner } from "@/components/ui/bar-spinner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved } = useThemeMode()

  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      position="bottom-right"
      icons={{
        success: (
          <CircleCheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
        ),
        info: (
          <InfoIcon className="size-4 text-blue-600 dark:text-blue-400" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" />
        ),
        error: (
          <OctagonXIcon className="size-4 text-destructive" />
        ),
        loading: (
          <BarSpinner className="size-4" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
