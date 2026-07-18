import { describe, it, expect } from "vitest";
import { defaultLocalPermissions, resolvePermissions, resolveEditorCapabilities, DCS_SOURCE_LOCK_REASON } from "./useProjectPermissions";
import type { ProjectRecord } from "@/lib/parsers/types";
import { ROLE } from "@/lib/frontier/roles";

// Helper: build a minimal ProjectRecord with a given syncRole level
function withRole(level: number): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    syncRole: { level, name: "test", source: "server", fetchedAt: new Date().toISOString() },
  }
}

// Helper: build a local project (no syncRole)
function localProject(): ProjectRecord {
  return {
    id: "local-1",
    name: "Local Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
  }
}

describe("resolvePermissions", () => {
  it("returns full-edit defaults for local projects with no permissions", () => {
    const p = resolvePermissions({ permissions: undefined } as ProjectRecord);
    expect(p).toEqual(defaultLocalPermissions);
    expect(p.canEditContent).toBe(true);
  });

  it("returns stored permissions verbatim when present", () => {
    const stored = { source: "gitlab", canEditContent: false, canEditComments: true,
      canResolveComments: false, canPush: false, accessLevel: 20 } as const;
    const p = resolvePermissions({ permissions: stored } as unknown as ProjectRecord);
    expect(p).toBe(stored);
  });
});

describe("resolveEditorCapabilities — local projects (no syncRole)", () => {
  it("returns canEdit=true, canValidate=true for local project with no syncRole", () => {
    const caps = resolveEditorCapabilities(localProject());
    expect(caps.canEdit).toBe(true);
    expect(caps.canValidate).toBe(true);
    expect(caps.readOnlyLabel).toBeNull();
  });

  it("returns canEdit=true for null/undefined project", () => {
    expect(resolveEditorCapabilities(null).canEdit).toBe(true);
    expect(resolveEditorCapabilities(undefined).canEdit).toBe(true);
  });

  it("respects stored ProjectPermissions for git-imported projects", () => {
    const gitReadOnly = {
      ...localProject(),
      permissions: {
        source: "gitlab" as const,
        canEditContent: false,
        canEditComments: false,
        canResolveComments: false,
        canPush: false,
      },
    };
    const caps = resolveEditorCapabilities(gitReadOnly);
    expect(caps.canEdit).toBe(false);
    expect(caps.canValidate).toBe(false);
    expect(caps.readOnlyLabel).toBe("Read-only (imported from git)");
  });
});

describe("resolveEditorCapabilities — cloud projects (syncRole present)", () => {
  it("viewer (100): canEdit=false, canValidate=false, has readOnlyLabel", () => {
    const caps = resolveEditorCapabilities(withRole(ROLE.VIEWER));
    expect(caps.canEdit).toBe(false);
    expect(caps.canValidate).toBe(false);
    expect(caps.readOnlyLabel).toBe("Viewing as viewer — read only");
  });

  it("commenter (200): canEdit=false, canValidate=false, has readOnlyLabel", () => {
    const caps = resolveEditorCapabilities(withRole(ROLE.COMMENTER));
    expect(caps.canEdit).toBe(false);
    expect(caps.canValidate).toBe(false);
    expect(caps.readOnlyLabel).toBe("Viewing as commenter — you can comment");
  });

  it("reviewer (300): canEdit=false, canValidate=true, has readOnlyLabel", () => {
    const caps = resolveEditorCapabilities(withRole(ROLE.REVIEWER));
    expect(caps.canEdit).toBe(false);
    expect(caps.canValidate).toBe(true);
    expect(caps.readOnlyLabel).toBe("Viewing as reviewer — you can validate and comment");
  });

  it("contributor (400): canEdit=true, canValidate=true, no badge", () => {
    const caps = resolveEditorCapabilities(withRole(ROLE.CONTRIBUTOR));
    expect(caps.canEdit).toBe(true);
    expect(caps.canValidate).toBe(true);
    expect(caps.readOnlyLabel).toBeNull();
  });

  it("project_lead (500): canEdit=true, canValidate=true, no badge", () => {
    const caps = resolveEditorCapabilities(withRole(ROLE.PROJECT_LEAD));
    expect(caps.canEdit).toBe(true);
    expect(caps.canValidate).toBe(true);
    expect(caps.readOnlyLabel).toBeNull();
  });

  it("maintainer (600): canEdit=true, canValidate=true, no badge", () => {
    const caps = resolveEditorCapabilities(withRole(ROLE.MAINTAINER));
    expect(caps.canEdit).toBe(true);
    expect(caps.canValidate).toBe(true);
    expect(caps.readOnlyLabel).toBeNull();
  });

  it("owner (700): canEdit=true, canValidate=true, no badge", () => {
    const caps = resolveEditorCapabilities(withRole(ROLE.OWNER));
    expect(caps.canEdit).toBe(true);
    expect(caps.canValidate).toBe(true);
    expect(caps.readOnlyLabel).toBeNull();
  });

  it("very low unknown level (50): canEdit=false, canValidate=false", () => {
    const caps = resolveEditorCapabilities(withRole(50));
    expect(caps.canEdit).toBe(false);
    expect(caps.canValidate).toBe(false);
    expect(caps.readOnlyLabel).toBe("Viewing as viewer — read only");
  });
});

describe("resolveEditorCapabilities — canEditSource (source.cell.commit gate)", () => {
  // Source editing matches the sync-worker source.cell.commit role floor
  // (PROJECT_LEAD, 500) and must be suppressed on live-linked downstreams,
  // whose mirrored source lane is read-only (server-enforced).
  function withLink(level: number, mode: "clone" | "live" | null): ProjectRecord {
    return { ...withRole(level), sourceLinkMode: mode };
  }

  it("project_lead (500) on a self-contained project can edit source", () => {
    expect(resolveEditorCapabilities(withRole(ROLE.PROJECT_LEAD)).canEditSource).toBe(true);
  });

  it("owner (700) can edit source", () => {
    expect(resolveEditorCapabilities(withRole(ROLE.OWNER)).canEditSource).toBe(true);
  });

  it("contributor (400) cannot edit source — below the 500 floor", () => {
    expect(resolveEditorCapabilities(withRole(ROLE.CONTRIBUTOR)).canEditSource).toBe(false);
  });

  it("reviewer (300) cannot edit source", () => {
    expect(resolveEditorCapabilities(withRole(ROLE.REVIEWER)).canEditSource).toBe(false);
  });

  it("project_lead on a CLONE-linked project can edit source (clone is independent)", () => {
    expect(resolveEditorCapabilities(withLink(ROLE.PROJECT_LEAD, "clone")).canEditSource).toBe(true);
  });

  it("project_lead on a LIVE-linked downstream cannot edit source (mirrored lane is locked)", () => {
    expect(resolveEditorCapabilities(withLink(ROLE.PROJECT_LEAD, "live")).canEditSource).toBe(false);
  });

  it("owner on a LIVE-linked downstream still cannot edit source", () => {
    expect(resolveEditorCapabilities(withLink(ROLE.OWNER, "live")).canEditSource).toBe(false);
  });

  it("local project (no syncRole) cannot edit source — feature targets cloud projects", () => {
    expect(resolveEditorCapabilities(localProject()).canEditSource).toBe(false);
  });

  it("null/undefined project cannot edit source", () => {
    expect(resolveEditorCapabilities(null).canEditSource).toBe(false);
    expect(resolveEditorCapabilities(undefined).canEditSource).toBe(false);
  });
});

describe("resolveEditorCapabilities — DCS upstream lockdown (hasDcsUpstream)", () => {
  // WHY: while a project is pinned to a Door43 upstream, the DCS repair path
  // treats ANY local source divergence as damage and silently overwrites it.
  // A hand-edit would therefore be destroyed on the next re-sync — so the
  // affordance must be locked for EVERY role; detaching in Project Settings
  // is the only sanctioned way out.

  it("cursor present forces canEditSource=false regardless of role", () => {
    for (const level of [ROLE.PROJECT_LEAD, ROLE.MAINTAINER, ROLE.OWNER]) {
      const caps = resolveEditorCapabilities(withRole(level), { hasDcsUpstream: true });
      expect(caps.canEditSource).toBe(false);
      expect(caps.sourceReadOnlyReason).toBe(DCS_SOURCE_LOCK_REASON);
    }
  });

  it("does not disturb target-side capabilities (canEdit/canValidate/readOnlyLabel)", () => {
    const caps = resolveEditorCapabilities(withRole(ROLE.MAINTAINER), { hasDcsUpstream: true });
    expect(caps.canEdit).toBe(true);
    expect(caps.canValidate).toBe(true);
    expect(caps.readOnlyLabel).toBeNull();
  });

  it("cursor absent preserves prior behavior and carries no source lock reason", () => {
    for (const opts of [undefined, {}, { hasDcsUpstream: false }]) {
      const caps = resolveEditorCapabilities(withRole(ROLE.PROJECT_LEAD), opts);
      expect(caps.canEditSource).toBe(true);
      expect(caps.sourceReadOnlyReason).toBeNull();
    }
  });

  it("lock-reason copy does not tell the reader to detach (detach needs MAINTAINER 600, but a project_lead 500 sees this copy)", () => {
    // AQU-615 review nit: the old copy said "detach in Project Settings to
    // edit", but the detach action is gated at MAINTAINER — a project_lead
    // would follow the instruction and find no such control. The copy must
    // attribute the action to a maintainer instead.
    expect(DCS_SOURCE_LOCK_REASON).toMatch(/a maintainer can detach/i);
    expect(DCS_SOURCE_LOCK_REASON).not.toMatch(/detach .* to edit/i);
  });

  it("LOADING policy: unknown linked-state must be passed as hasDcsUpstream=true (default-locked)", () => {
    // EditorTable passes `hasDcsUpstream: loading || cursor !== null` — while
    // the settings fetch is in flight the lock is ON. Default-locked can never
    // let a doomed source edit through; the only cost is that a project_lead+
    // user on an ordinary cloud project sees the affordance one settings GET
    // late. This test pins the contract that `true` locks even when the caller
    // has no cursor in hand yet.
    const caps = resolveEditorCapabilities(withRole(ROLE.OWNER), { hasDcsUpstream: true });
    expect(caps.canEditSource).toBe(false);
  });
});
