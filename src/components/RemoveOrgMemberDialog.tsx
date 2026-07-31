import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { removeProjectMember } from "@/lib/frontier/members";
import { useFrontierSession } from "@/hooks/useFrontierSession";
import type { OrgMemberProject } from "@/lib/frontier/orgs";
import { RoleLabel } from "@/components/RoleLabel";

interface RemoveOrgMemberDialogProps {
  orgId: number;
  orgName: string;
  userId: number;
  username: string;
  listProjects: () => Promise<OrgMemberProject[]>;
  onClose: () => void;
  onConfirmed: () => Promise<void>;
}

export function RemoveOrgMemberDialog({
  orgName,
  userId,
  username,
  listProjects,
  onClose,
  onConfirmed,
}: RemoveOrgMemberDialogProps) {
  const { session } = useFrontierSession();
  const [projects, setProjects] = useState<OrgMemberProject[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((p) => {
        if (!cancelled) {
          setProjects(p);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [listProjects]);

  function toggle(id: string) {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConfirm() {
    if (!session?.jwt) return;
    setSubmitting(true);
    setError(null);
    try {
      // Remove from each opted-in project first, so partial failures still
      // leave the org membership intact for retry.
      for (const projectId of checked) {
        await removeProjectMember(session.jwt, projectId, userId);
      }
      await onConfirmed(); // org-side removal
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const checkedCount = checked.size;
  const buttonLabel = checkedCount > 0
    ? `Remove from org and ${checkedCount} project${checkedCount === 1 ? "" : "s"}`
    : "Remove from org";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {username} from {orgName}?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p>
            {username} will lose org-wide access. They will still keep access to any
            projects they were added to individually unless you also remove them below.
          </p>
          {loading && <p className="text-muted-foreground">Loading projects…</p>}
          {!loading && projects && projects.length === 0 && (
            <p className="text-muted-foreground">No direct project memberships in this org.</p>
          )}
          {!loading && projects && projects.length > 0 && (
            <ul className="space-y-1 rounded border p-2">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`rm-${p.id}`}
                    checked={checked.has(p.id)}
                    onCheckedChange={() => toggle(p.id)}
                    disabled={submitting}
                  />
                  <label htmlFor={`rm-${p.id}`} className="flex-1">
                    {p.name}{" "}
                    <span className="text-xs text-muted-foreground">(<RoleLabel name={p.role.name} />)</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={submitting}>
            {buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
