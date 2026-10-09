// How a `user.role` value is read — by the Worker's guards and by the shell alike.
//
// Better Auth's admin plugin stores one role or a comma-separated list ("user,admin"). Both
// sides must split it the same way: a client that compared the whole string with "admin" showed
// an admin whose role is stored as a list the not-found page for /admin.

/** True when the role value names `admin`, alone or in a comma-separated list. Case-sensitive. */
export function hasAdminRole(role: string | null | undefined): boolean {
  return (role ?? "").split(",").some((entry) => entry.trim() === "admin");
}
