import { UserRole, type User } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";

import { verifyToken, type SessionClaims } from "./jwt";
import { getSessionToken } from "./session";

/**
 * Route-handler authorisation guards.
 *
 * The contract for every protected route:
 *
 *   export async function GET() {
 *     try {
 *       const user = await requireAdmin();
 *       ...
 *     } catch (error) {
 *       return handleApiError(error);
 *     }
 *   }
 *
 * `requireUser` and `requireAdmin` throw an `ApiError` on failure, so a
 * handler can abort from any depth without every call site checking a
 * return value.
 */

/**
 * The user shape returned by the guards.
 *
 * Deliberately narrower than the full Prisma `User` row: it excludes
 * `passwordHash`, so there is no way to accidentally serialise it into a
 * response body.
 */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  phone: string | null;
  smsOptIn: boolean;
};

/**
 * The subset of the `User` row the guards actually load.
 *
 * The lookup uses Prisma's `select`, so it returns exactly these columns —
 * not the full `User` row. Typing it explicitly keeps the return type
 * honest and stops `createdAt`/`updatedAt` from being required.
 */
type SelectedUser = Pick<
  User,
  | "id"
  | "email"
  | "name"
  | "role"
  | "phone"
  | "smsOptIn"
  | "passwordHash"
>;

/**
 * Projects a Prisma User row onto the safe SessionUser shape.
 */
function toSessionUser(user: SelectedUser): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    phone: user.phone,
    smsOptIn: user.smsOptIn,
  };
}

/**
 * Resolves the signed-in user, or `null` when there is no valid session.
 *
 * Performs a database lookup so the returned role is always current. A
 * token minted before a role change cannot preserve stale privileges.
 */
export async function getOptionalUser(): Promise<SessionUser | null> {
  const token = await getSessionToken();
  const claims = await verifyToken(token);
  if (!claims) return null;

  const user = await loadUserForClaims(claims);

  if (!user) return null;

  return toSessionUser(user);
}

/**
 * Looks up the current user record for a set of token claims.
 *
 * The role in the token is deliberately NOT trusted. It can be up to seven
 * days stale, so a user demoted from ADMIN would otherwise keep admin
 * access until their token expired. The database is the authority.
 *
 * A database failure is surfaced as an error rather than being swallowed.
 * Failing open (treating the request as authorised) would be a security
 * hole; failing as a bare 500 without logging would hide an infrastructure
 * problem behind what looks like a client error.
 *
 * @throws ApiError 401 when the user no longer exists.
 * @throws ApiError 500 when the database is unreachable.
 */
async function loadUserForClaims(
  claims: SessionClaims,
): Promise<SelectedUser | null> {
  try {
    return await db.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        phone: true,
        smsOptIn: true,
        passwordHash: true,
      },
    });
  } catch (error) {
    console.error("[auth] Database lookup failed during authorisation:", error);

    throw new ApiError(
      "INTERNAL_ERROR",
      "Unable to verify your session right now. Please try again shortly.",
    );
  }
}

/**
 * Requires a valid session.
 *
 * @throws ApiError 401 when the caller is not authenticated.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getOptionalUser();

  if (!user) {
    throw ApiError.unauthenticated(
      "You must be signed in to do that.",
    );
  }

  return user;
}

/**
 * Requires a session with the ADMIN role.
 *
 * Two separate checks are performed deliberately:
 *
 *  1. The token's `role` claim is checked first — a cheap rejection for
 *     the overwhelmingly common case of a customer hitting an admin route.
 *
 *  2. The role is then re-read from the database. This is the authoritative
 *     check. The claim in the token is a convenience that may be up to
 *     seven days stale, so it must never be the sole basis for granting
 *     admin access.
 *
 * @throws ApiError 401 when unauthenticated, 403 when the role is wrong,
 *         500 when the database is unreachable.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const token = await getSessionToken();
  const claims = await verifyToken(token);

  if (!claims) {
    throw ApiError.unauthenticated("You must be signed in to do that.");
  }

  // Fast path: the token itself says this is not an admin.
  if (claims.role !== UserRole.ADMIN) {
    throw ApiError.forbidden("This action requires administrator access.");
  }

  // Authoritative check: confirm the role is still ADMIN in the database.
  const user = await loadUserForClaims(claims);

  if (!user) {
    throw ApiError.unauthenticated("You must be signed in to do that.");
  }

  if (user.role !== UserRole.ADMIN) {
    throw ApiError.forbidden("This action requires administrator access.");
  }

  return toSessionUser(user);
}

/**
 * Requires a session that may act on **the caller's own** customer-scoped
 * data — their cart, their orders, their profile.
 *
 * ── Why this admits an administrator ─────────────────────────────────────
 *
 * This guard used to demand the CUSTOMER role outright, and it was wrong.
 *
 * Every route that called it scoped its query by the caller's own id:
 * `getCart(user.id)`, `listOrders(user.id, …)`, `placeOrder(user.id, …)`,
 * `openSslCommerzSession(user.id, orderId)`. The ownership was already
 * enforced by the query, so the role check added nothing — except that it
 * locked an administrator out of the **storefront**.
 *
 * An administrator is a person. They wear the same shop as the customers,
 * they can buy the same products, and they were getting a `403
 * "This action is only available to customer accounts."` on their own
 * cart. That is the bug this function existed to prevent, and it was
 * preventing the thing it should have allowed.
 *
 * ── Why it is still a guard, and not just `requireUser` ──────────────────
 *
 * The distinction it was written to protect is real, and it lives
 * somewhere else: an administrator acting **on somebody else's** data.
 * That is a different actor, a different audit action and a different
 * route — `/api/admin/orders/[id]/payment` and
 * `/api/admin/orders/[id]/status`, both behind `requireAdmin`.
 *
 * So the rule is:
 *
 *   • Your **own** data → this guard. The `userId` scope does the work.
 *   • Somebody **else's** data → the admin routes, behind `requireAdmin`.
 *
 * Two paths, two audit trails, one database. The old version merged them
 * by making the first path unavailable to staff, which protected nothing
 * and broke the shop.
 *
 * @throws ApiError 401 when unauthenticated.
 */
export async function requireCustomer(): Promise<SessionUser> {
  return requireUser();
}
