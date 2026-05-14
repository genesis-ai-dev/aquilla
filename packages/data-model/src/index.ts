// @aquilla/data-model — canonical shared TS types.
//
// Apps and the web client import from here:
//   import type { CellRow, RawEvent, Project } from "@aquilla/data-model"
//
// The sync-worker + auth-worker vendor their own copies because CF Workers
// can't import workspace packages at runtime — keep them in lockstep
// manually. This package is the source of truth for the shape; the Workers
// shadow it.

export type {
  EventKind,
  EventPayloads,
  PayloadFor,
  RawEvent,
  EventClaims,
} from "./events"

export { CHAIN_MUTATING_KINDS } from "./events"

export type {
  CellSide,
  FileSummary,
  CellRow,
  CellsPage,
  CellHistoryEntry,
} from "./cells"

export type {
  RoleLevel,
  RoleName,
  Project,
  ProjectMember,
  ProjectInvite,
  ProjectSettings,
  TranslationRule,
  OrgMember,
  Org,
  DownstreamProject,
  DetachResult,
} from "./projects"

export type {
  User,
  LoginRequest,
  LoginResponse,
  SignupRequest,
  PasswordResetRequestBody,
  PasswordResetSubmitBody,
  AccessTokenClaims,
  SyncTokenClaims,
} from "./auth"
