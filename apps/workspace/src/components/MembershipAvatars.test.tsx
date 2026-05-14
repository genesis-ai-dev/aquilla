import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MembershipAvatars } from "./MembershipAvatars";

const members = [
  { userId: 1, username: "wendy", role: { level: 700, name: "owner", source: "creator" as const } },
  { userId: 2, username: "anna", role: { level: 600, name: "maintainer", source: "org" as const } },
  { userId: 3, username: "clayton", role: { level: 400, name: "contributor", source: "override" as const } },
  { userId: 4, username: "valerie", role: { level: 400, name: "contributor", source: "override" as const } },
  { userId: 5, username: "amir", role: { level: 400, name: "contributor", source: "override" as const } },
];

describe("MembershipAvatars", () => {
  it("renders up to maxVisible avatars and an overflow chip", () => {
    render(<MembershipAvatars members={members} maxVisible={3} />);
    expect(screen.getByText("W")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("renders nothing for empty list", () => {
    const { container } = render(<MembershipAvatars members={[]} maxVisible={3} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders no overflow chip when count <= maxVisible", () => {
    render(<MembershipAvatars members={members.slice(0, 2)} maxVisible={3} />);
    expect(screen.queryByText(/^\+/)).toBeNull();
  });
});
