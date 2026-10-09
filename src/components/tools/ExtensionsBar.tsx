/**
 * Smart Extensions bar above the file view, so installed extensions surface
 * where they are relevant without visiting the management page:
 * - the editor switcher (extensions with the `editor` mount),
 * - pinned extensions (one click opens them in the side panel),
 * - the extensions palette (button or Ctrl/Cmd+Shift+E): open in side panel,
 *   use as this file's editor, open full page, manage.
 * Shown only once the project has at least one extension installed.
 */

import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { Blocks, Pin } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ExtensionEditorChoice } from "./ExtensionEditor"
import { ExtensionEditorSwitcher, FirstPartyBadge } from "./ExtensionEditor"
import { useToolsMount } from "./ToolsMountContext"

export function ExtensionsBar({ choice }: { choice: ExtensionEditorChoice }) {
  const t = useT()
  const ctx = useToolsMount()
  const navigate = useNavigate()
  const setPaletteOpen = ctx?.setPaletteOpen

  useEffect(() => {
    if (!setPaletteOpen) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setPaletteOpen])

  if (!ctx || ctx.tools.length === 0) return null
  const pinned = ctx.tools.filter((tool) => ctx.pinned.includes(tool.id) && tool.manifest.mounts.includes("panel"))
  const run = (fn: () => void) => {
    ctx.setPaletteOpen(false)
    fn()
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1 text-xs" data-testid="extensions-bar">
      <ExtensionEditorSwitcher choice={choice} />
      <FirstPartyBadge toolId={choice.selected} />
      {pinned.map((tool) => (
        <Button key={tool.id} size="xs" variant="outline" onClick={() => ctx.openInPanel(tool.id)} data-testid="pinned-extension">
          <Pin className="size-3" aria-hidden />
          {tool.name}
        </Button>
      ))}
      <Button size="xs" variant="ghost" className="ms-auto" onClick={() => ctx.setPaletteOpen(true)}>
        <Blocks className="size-3.5" aria-hidden />
        {t("extensions.palette.button")}
      </Button>
      <CommandDialog open={ctx.paletteOpen} onOpenChange={ctx.setPaletteOpen} title={t("extensions.palette.title")} description={t("extensions.palette.placeholder")}>
        <Command>
          <CommandInput placeholder={t("extensions.palette.placeholder")} />
          <CommandList>
            <CommandEmpty>{t("extensions.palette.empty")}</CommandEmpty>
            <CommandGroup heading={t("extensions.palette.title")}>
              {ctx.tools.flatMap((tool) => [
                ...(tool.manifest.mounts.includes("editor")
                  ? [
                      <CommandItem key={`${tool.id}:editor`} onSelect={() => run(() => choice.choose(tool.id, false))}>
                        {t("extensions.palette.useAsEditor", { name: tool.name })}
                      </CommandItem>,
                    ]
                  : []),
                ...(tool.manifest.mounts.includes("panel")
                  ? [
                      <CommandItem key={`${tool.id}:panel`} onSelect={() => run(() => ctx.openInPanel(tool.id))}>
                        {t("extensions.palette.openPanel", { name: tool.name })}
                      </CommandItem>,
                    ]
                  : []),
                <CommandItem key={`${tool.id}:page`} onSelect={() => run(() => navigate(`/project/${ctx.projectId}/extensions/${tool.id}`))}>
                  {t("extensions.palette.openPage", { name: tool.name })}
                </CommandItem>,
              ])}
              <CommandItem onSelect={() => run(() => navigate(`/project/${ctx.projectId}/extensions`))}>
                {t("extensions.palette.manage")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </div>
  )
}
