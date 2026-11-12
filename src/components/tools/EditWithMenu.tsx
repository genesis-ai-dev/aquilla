/**
 * Smart Extensions: the one "Edit with" control above the editor (Daniel,
 * 2026-10-14). A popover menu, not a native select:
 *   - the native "Aquilla editor" first, then the Smart Extension editors
 *     (host-drawn iris marker), each with an icon, its name and a one-line hint;
 *     the current editor is checked and the project default is marked "Default";
 *   - picking an item = this file's editor (the switch back to the native editor
 *     is just picking it); "Set as default for this project" = every file.
 *     Both are the user's own local choice (editor-choice.ts): no role or
 *     extension permission gates them, as before;
 *   - the current extension's permissions and versions, and "Build a new
 *     editor…", are quiet items in the menu, not separate toolbar buttons.
 * The auto-native fallback on a load failure is unchanged (ExtensionEditor).
 */

import { useNavigate } from "react-router-dom"
import { Blocks, Check, ChevronDown, PenLine, Plus, ShieldCheck, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useT } from "@/lib/i18n/I18nProvider"
import { STANDARD_EDITOR } from "@/lib/tools/editor-choice"
import { cn } from "@/lib/utils"
import type { ExtensionEditorChoice } from "./ExtensionEditor"
import { ExtensionMarker } from "./ExtensionMarker"
import { useToolsMount } from "./ToolsMountContext"

function Hint({ children }: { children: string }) {
  return <span className="block truncate text-xs text-muted-foreground">{children}</span>
}

function DefaultBadge({ label }: { label: string }) {
  return (
    <span className="ms-auto shrink-0 rounded-full border px-1.5 text-[10px] font-medium leading-4 text-muted-foreground" data-testid="edit-with-default-badge">
      {label}
    </span>
  )
}

export function EditWithMenu({ choice }: { choice: ExtensionEditorChoice }) {
  const t = useT()
  const ctx = useToolsMount()
  const navigate = useNavigate()
  if (choice.editors.length === 0) return null
  const projectId = ctx?.projectId ?? null
  const current = choice.editors.find((ed) => ed.id === choice.selected) ?? null
  const currentName = current?.name ?? t("extensions.editor.standard")
  const isDefault = (id: string) => choice.projectDefault === id
  const defaultLabel = t("extensions.editor.defaultBadge")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="h-7 max-w-[22rem] gap-1.5 rounded-md border border-transparent px-2 hover:border-border hover:bg-background data-popup-open:border-border data-popup-open:bg-background"
            aria-label={t("extensions.editor.trigger", { name: currentName })}
            data-testid="edit-with-trigger"
            data-editor={choice.selected}
          />
        }
      >
        {current ? <ExtensionMarker iconOnly /> : <PenLine className="size-3.5 text-muted-foreground" aria-hidden />}
        <span className="text-muted-foreground">{t("extensions.editor.label")}</span>
        <span className="min-w-0 truncate font-medium text-foreground">{currentName}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[22rem] max-w-[calc(100vw-2rem)] p-1" align="start">
        <DropdownMenuRadioGroup value={choice.selected} onValueChange={(value) => choice.choose(String(value), false)}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("extensions.editor.nativeGroup")}</DropdownMenuLabel>
            <DropdownMenuRadioItem closeOnClick value={STANDARD_EDITOR} className="items-start gap-2 py-1.5" data-testid="edit-with-item">
              <PenLine className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{t("extensions.editor.standard")}</span>
                  {isDefault(STANDARD_EDITOR) && <DefaultBadge label={defaultLabel} />}
                </span>
                <Hint>{t("extensions.editor.nativeHint")}</Hint>
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <ExtensionMarker label={t("extensions.identity.groupLabel")} />
            </DropdownMenuLabel>
            {choice.editors.map((ed) => (
              <DropdownMenuRadioItem closeOnClick key={ed.id} value={ed.id} className="items-start gap-2 py-1.5" data-testid="edit-with-item">
                <span className="mt-0.5" aria-hidden>
                  <ExtensionMarker iconOnly />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{ed.name}</span>
                    {isDefault(ed.id) && <DefaultBadge label={defaultLabel} />}
                  </span>
                  <Hint>{ed.manifest.description?.trim() || t("extensions.editor.extensionHint")}</Hint>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {isDefault(choice.selected) ? (
          <DropdownMenuItem disabled className="gap-2 text-muted-foreground">
            <Check className="size-4" aria-hidden />
            {t("extensions.editor.isDefault")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem className="gap-2" onClick={() => choice.choose(choice.selected, true)} data-testid="edit-with-set-default">
            <Star className="size-4 text-muted-foreground" aria-hidden />
            <span className="min-w-0">
              <span className="block">{t("extensions.editor.setDefault")}</span>
              <Hint>{t("extensions.editor.setDefaultHint", { name: currentName })}</Hint>
            </span>
          </DropdownMenuItem>
        )}
        {current && projectId && (
          <DropdownMenuItem className="gap-2" onClick={() => navigate(`/project/${projectId}/extensions/${current.id}`)} data-testid="edit-with-permissions">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
            {t("extensions.editor.permissions")}
          </DropdownMenuItem>
        )}
        {projectId && (
          <DropdownMenuItem
            className={cn("gap-2 text-muted-foreground")}
            onClick={() => navigate(`/project/${projectId}/extensions?where=editor`)}
            data-testid="build-own-editor"
          >
            <Plus className="size-4" aria-hidden />
            {t("extensions.editor.buildNew")}
            <Blocks className="ms-auto size-3.5 opacity-60" aria-hidden />
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
