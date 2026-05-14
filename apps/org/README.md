# @aquilla/org

Org admin app. Mounted at `/org/*`.

Source workspace SPA surfaces this replaces:
- `src/pages/MembersPage.tsx`
- `src/components/MembersMatrixView.tsx`
- `src/components/MembersMatrixCellEditor.tsx`
- `src/components/MultiProjectInviteDialog.tsx`
- `src/components/RemoveOrgMemberDialog.tsx`

## Routes

| Path            | Component       | Status |
|-----------------|-----------------|--------|
| `/`             | `OrgListPage`   | Phase 3c (single-org case live via api-client) |
| `/members`      | `MembersPage`   | stub — Phase 3a relocates `useProjectsMembersMatrix` |
| `/invite`       | `InvitePage`    | stub — needs `multi-project-invites` wrapper in api-client |

## Dev

```bash
pnpm --filter @aquilla/org dev
pnpm --filter @aquilla/org build
pnpm --filter @aquilla/org test
```
