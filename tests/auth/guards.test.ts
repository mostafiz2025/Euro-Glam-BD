import { UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route-handler authorisation guards.
 *
 * ── The rule under test ──────────────────────────────────────────────────
 *
 * `requireCustomer` guards the caller's **own** customer-scoped data —
 * their cart, their orders, their profile. Every route that calls it
 * scopes the query by the caller's own id (`getCart(user.id)`,
 * `listOrders(user.id, …)`, `placeOrder(user.id, …)`), so the ownership
 * is enforced by the query.
 *
 * It therefore admits **an administrator**.
 *
 * ── Why this is a bug being pinned, not a convenience ────────────────────
 *
 * The guard used to demand the CUSTOMER role outright. That locked an
 * administrator out of the storefront: they were signed in, browsing the
 * same shop as everybody else, and got
 *
 *   403 "This action is only available to customer accounts."
 *
 * on their own cart. The restriction protected nothing — the `userId`
 * scope already prevented anyone from reaching another person's data —
 * and it broke the shop for staff.
 *
 * The distinction it was written for is real and lives elsewhere:
 * an administrator acting on **somebody else's** data is a different
 * actor with a different audit action, and it has its own routes under
 * `/api/admin/*` behind `requireAdmin`.
 *
 *   • Your own data       → `requireCustomer` (the `userId` scope).
 *   • Somebody else's data → the admin routes, behind `requireAdmin`.
 */

const sessionUser: {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  phone: string | null;
  smsOptIn: boolean;
} = {
  id: "user_123",
  email: "shopper@example.com",
  name: "A Shopper",
  role: UserRole.CUSTOMER,
  phone: null,
  smsOptIn: false,
};

const adminUser = {
  ...sessionUser,
  id: "admin_456",
  email: "admin@euroglambd.com",
  name: "Euro Glam Admin",
  role: UserRole.ADMIN,
};

const getSessionToken = vi.fn();
const verifyToken = vi.fn();
const findUnique = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionToken: async () => getSessionToken(),
}));

vi.mock("@/lib/auth/jwt", () => ({
  verifyToken: async (token: string | undefined) => verifyToken(token),
  SESSION_COOKIE_NAME: "egb_session",
}));

import {
  requireAdmin,
  requireCustomer,
  requireUser,
} from "@/lib/auth/guards";

/**
 * Makes the session resolve to the given user.
 */
function signedInAs(user: typeof sessionUser): void {
  getSessionToken.mockResolvedValue("a-token");
  verifyToken.mockResolvedValue({ sub: user.id, role: user.role });
  findUnique.mockResolvedValue({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    phone: user.phone,
    smsOptIn: user.smsOptIn,
    passwordHash: "a-hash",
  });
}

beforeEach(() => {
  getSessionToken.mockReset();
  verifyToken.mockReset();
  findUnique.mockReset();
});

describe("requireCustomer admits a signed-in shopper", () => {
  it("returns the customer", async () => {
    signedInAs(sessionUser);

    await expect(requireCustomer()).resolves.toMatchObject({
      id: sessionUser.id,
      role: UserRole.CUSTOMER,
    });
  });

  it("returns an administrator too — they shop on the storefront", async () => {
    signedInAs(adminUser);

    // The bug: an admin was getting a 403 on their own cart.
    await expect(requireCustomer()).resolves.toMatchObject({
      id: adminUser.id,
      role: UserRole.ADMIN,
    });
  });

  it("never leaks the password hash", async () => {
    signedInAs(adminUser);

    const user = await requireCustomer();

    expect(user).not.toHaveProperty("passwordHash");
  });

  it("rejects an unauthenticated caller", async () => {
    getSessionToken.mockResolvedValue(undefined);
    verifyToken.mockResolvedValue(null);

    await expect(requireCustomer()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("rejects a caller whose account has been deleted", async () => {
    getSessionToken.mockResolvedValue("a-token");
    verifyToken.mockResolvedValue({ sub: "gone", role: UserRole.CUSTOMER });
    findUnique.mockResolvedValue(null);

    await expect(requireCustomer()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });
});

describe("requireAdmin still refuses a customer", () => {
  it("rejects a customer", async () => {
    signedInAs(sessionUser);

    await expect(requireAdmin()).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("admits an administrator", async () => {
    signedInAs(adminUser);

    await expect(requireAdmin()).resolves.toMatchObject({
      id: adminUser.id,
      role: UserRole.ADMIN,
    });
  });

  it("refuses a token that claims ADMIN when the database no longer agrees", async () => {
    // The token is stale — the user was demoted after it was minted. The
    // database is the authority, so the request is refused.
    getSessionToken.mockResolvedValue("a-token");
    verifyToken.mockResolvedValue({ sub: adminUser.id, role: UserRole.ADMIN });
    findUnique.mockResolvedValue({
      id: adminUser.id,
      email: adminUser.email,
      name: adminUser.name,
      role: UserRole.CUSTOMER,
      phone: null,
      smsOptIn: false,
      passwordHash: "a-hash",
    });

    await expect(requireAdmin()).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });
});

describe("requireUser is unchanged", () => {
  it("admits a customer and an administrator alike", async () => {
    signedInAs(sessionUser);
    await expect(requireUser()).resolves.toMatchObject({ id: sessionUser.id });

    signedInAs(adminUser);
    await expect(requireUser()).resolves.toMatchObject({ id: adminUser.id });
  });
});
