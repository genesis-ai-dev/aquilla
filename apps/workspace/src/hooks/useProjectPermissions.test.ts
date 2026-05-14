import { describe, it, expect } from "vitest";
import { defaultLocalPermissions, resolvePermissions } from "./useProjectPermissions";
import type { ProjectRecord } from "@/lib/parsers/types";

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
