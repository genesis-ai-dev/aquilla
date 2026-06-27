import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  Button,
} from "codex-web-app"

export function RowActions() {
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 8 }}>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm">Gospel of Mark ⋯</Button>}
        />
        <DropdownMenuContent style={{ minWidth: 200 }}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Project actions</DropdownMenuLabel>
            <DropdownMenuItem>
              Rename
              <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuItem>Export USFM</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">Delete project</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
