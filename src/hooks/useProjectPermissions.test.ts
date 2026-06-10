import { describe, it, expect } from "vitest";
import { defaultLocalPermissions, resolvePermissions, resolveEditorCapabilities } from "./useProjectPermissions";
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
