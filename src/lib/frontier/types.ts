export interface FrontierSession {
  jwt: string;
  username: string;
  createdAt: string;      // ISO
  /** Email decoded from the JWT `email` claim at login time, if present. */
  email?: string;
}
