export interface FrontierSession {
  jwt: string;
  username: string;
  /** Immutable server identity and stable browser data namespace (AQU-2534). */
  accountId?: string;
  storageKey?: string;
  createdAt: string;      // ISO
  /** Email decoded from the JWT `email` claim at login time, if present. */
  email?: string;
}
