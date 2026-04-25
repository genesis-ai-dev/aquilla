import { useState } from "react";
import { useOrg, useOrgMembers } from "@/hooks/useOrg";
import { MembersPanel, type MembersPanelMember } from "@/components/MembersPanel";
import { RemoveOrgMemberDialog } from "@/components/RemoveOrgMemberDialog";

const ORG_ROLE_OPTIONS = [
  { level: 100, name: "viewer", description: "Read-only across all projects" },
  { level: 400, name: "contributor", description: "Edit content across all projects" },
  { level: 500, name: "project_lead", description: "Manage members on every project" },
  { level: 600, name: "maintainer", description: "Lead + manage roles" },
];

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
    source: m.role.level === 700 ? "owner-of-org" : "override",
    isLocked: m.role.level === 700, // owner can't be removed
    lockedHint: m.role.level === 700 ? "Org owner" : undefined,
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
        defaultRole={600}
        callerUserId={callerUserId}
        callerMaxRole={600}
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
