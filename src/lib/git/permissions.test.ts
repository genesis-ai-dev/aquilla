import { describe, it, expect } from "vitest";
import { mapGitlabAccessLevel } from "./permissions";

describe("mapGitlabAccessLevel", () => {
  it("guest (10): comments disabled, no edits, no resolve", () => {
    const p = mapGitlabAccessLevel(10);
    expect(p).toEqual({
      source: "gitlab", canEditContent: false, canEditComments: false,
      canResolveComments: false, canPush: false, accessLevel: 10,
    });
  });

  it("reporter (20): comments yes, no resolve, no content", () => {
    const p = mapGitlabAccessLevel(20);
    expect(p.canEditComments).toBe(true);
    expect(p.canResolveComments).toBe(false);
    expect(p.canEditContent).toBe(false);
  });

  it("developer (30)+: still no content edits in Phase 1 (push not wired)", () => {
    const p = mapGitlabAccessLevel(30);
    expect(p.canEditContent).toBe(false);
    expect(p.canEditComments).toBe(true);
    expect(p.canResolveComments).toBe(true);
    expect(p.canPush).toBe(false);
  });

  it("undefined defaults to guest", () => {
    const p = mapGitlabAccessLevel(undefined);
    expect(p.canEditComments).toBe(false);
  });
});
