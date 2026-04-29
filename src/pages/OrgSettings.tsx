import { useState } from "react";
import { useOrg, useOrgMembers } from "@/hooks/useOrg";
import { MembersPanel, type MembersPanelMember } from "@/components/MembersPanel";
import { RemoveOrgMemberDialog } from "@/components/RemoveOrgMemberDialog";
import { ROLE, ORG_ROLE_PICKER, roleName } from "@/lib/frontier/roles";

// Org-scope descriptions differ from project-scope ("across all projects"),
// so we keep a small local mapping rather than reusing roleDescription().
const ORG_ROLE_DESCRIPTIONS: Record<number, string> = {
  [ROLE.VIEWER]: "Read-only across all projects",
  [ROLE.CONTRIBUTOR]: "Edit content across all projects",
  [ROLE.PROJECT_LEAD]: "Manage members on every project",
  [ROLE.MAINTAINER]: "Lead + manage roles",
};

const ORG_ROLE_OPTIONS = ORG_ROLE_PICKER.map((level) => ({
  level,
  name: roleName(level),
  description: ORG_ROLE_DESCRIPTIONS[level] ?? "",
}));

export function OrgSettings() {
  // FrontierSession doesn't carry a userId; the server enforces self-grant
  // rejection regardless. Pass null and skip the local self-block.
  const callerUserId = null;
  const { org, error: orgError } = useOrg();
  const { members, error: listError, add, remove, listMemberProjects, refresh } =
    useOrgMembers(org?.id ?? null);

  const [removeTarget, setRemoveTarget] = useState<{ userId: number; username: string } | null>(null);

  if (orgError) return <p className="p-4 text-destructive">{orgError}</p>;
  if (!org) return <p className="p-4 text-muted-foreground">Loading…</p>;

  const panelMembers: MembersPanelMember[] = members.map((m) => ({
    userId: m.userId,
    username: m.username,
    roleLevel: m.role.level,
    roleName: m.role.name,
    source: m.role.level === ROLE.OWNER ? "owner-of-org" : "override",
    isLocked: m.role.level === ROLE.OWNER, // owner can't be removed
    lockedHint: m.role.level === ROLE.OWNER ? "Org owner" : undefined,
  }));

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-xl font-semibold">{org.name ?? "Organization"}</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Members here have access to every project in the organization at the role you set.
      </p>
      {listError && <p className="mb-2 text-xs text-destructive">{listError}</p>}
      <MembersPanel
        members={panelMembers}
        roleOptions={ORG_ROLE_OPTIONS}
        defaultRole={ROLE.MAINTAINER}
        callerUserId={callerUserId}
        callerMaxRole={ROLE.MAINTAINER}
        onAdd={async (username, role) => {
          const result = await add(username, role);
          return result
            ? { ok: true }
            : { ok: false, error: "Could not add user. Username may not exist." };
        }}
        onRemove={(userId) => {
          const target = members.find((m) => m.userId === userId);
          if (target) setRemoveTarget({ userId: target.userId, username: target.username });
          return Promise.resolve();
        }}
        onChangeRole={async (username, role) => {
          await add(username, role);
        }}
      />

      {removeTarget && (
        <RemoveOrgMemberDialog
          orgId={org.id}
          orgName={org.name ?? "the organization"}
          userId={removeTarget.userId}
          username={removeTarget.username}
          listProjects={() => listMemberProjects(removeTarget.userId)}
          onClose={() => setRemoveTarget(null)}
          onConfirmed={async () => {
            await remove(removeTarget.userId);
            await refresh();
            setRemoveTarget(null);
          }}
        />
      )}
    </div>
  );
}
