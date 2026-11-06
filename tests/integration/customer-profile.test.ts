import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  changeCustomerPassword,
  getCustomerProfile,
  updateCustomerProfile,
} from "@/lib/account/profile";
import { verifyPassword } from "@/lib/auth/password";
import { hashPassword } from "@/lib/auth/password";
import { ApiError } from "@/lib/api/errors";

/**
 * The customer's own account, against a real database.
 *
 * These tests prove the properties that make it safe to expose:
 *
 *   1. A partial update changes only what it names — an untouched field
 *      is left exactly as it was.
 *   2. The write applies to the **caller's own row**, and to no other.
 *   3. The saved address round-trips, and is cleared by `null`.
 *   4. A password change requires the **current** password, and the
 *      new password is stored **hashed** — never in the clear.
 *   5. A failed password change leaves the stored password alone.
 *   6. The role and the SMS consent are never written.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];

const runId = `cust${Date.now()}${Math.floor(Math.random() * 100000)}`;

/**
 * Creates a customer for the test.
 */
async function createCustomer(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Customer",
      email,
      passwordHash: await hashPassword("the original password"),
      role: "CUSTOMER",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the customer " +
        "profile integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) return;

  await prisma.user.deleteMany({
    where: { id: { in: createdUserIds } },
  });
});

describe("the customer profile service", () => {
  it("reads the profile of the signed-in customer", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_read@example.com`);

    const profile = await getCustomerProfile(customerId);

    expect(profile.id).toBe(customerId);
    expect(profile.email).toBe(`${runId}_read@example.com`);
    expect(profile.name).toBe("Test Customer");
    expect(profile.phone).toBeNull();
    expect(profile.defaultAddress).toBeNull();
  });

  it("refuses to read a profile that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      getCustomerProfile("no-such-customer-id"),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("changes the name and the telephone number", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_name@example.com`);

    const saved = await updateCustomerProfile(customerId, {
      name: "Ayesha Rahman",
      phone: "+8801712345678",
    });

    expect(saved.name).toBe("Ayesha Rahman");
    expect(saved.phone).toBe("+8801712345678");
  });

  it("leaves the fields the update did not name alone", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_partial@example.com`);

    await prisma.user.update({
      where: { id: customerId },
      data: { phone: "+8801712345678" },
    });

    const saved = await updateCustomerProfile(customerId, { name: "Renamed" });

    // The name changed; the phone number did not.
    expect(saved.name).toBe("Renamed");
    expect(saved.phone).toBe("+8801712345678");
  });

  it("clears the telephone number when it is emptied", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_clear@example.com`);

    await prisma.user.update({
      where: { id: customerId },
      data: { phone: "+8801712345678" },
    });

    const saved = await updateCustomerProfile(customerId, { phone: null });

    expect(saved.phone).toBeNull();
  });

  it("saves the delivery address and reads it back", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_address@example.com`);

    const saved = await updateCustomerProfile(customerId, {
      address: {
        fullName: "Ayesha Rahman",
        phone: "+8801712345678",
        addressLine1: "House 12, Road 5, Block C",
        addressLine2: "Flat 3B",
        city: "Dhaka",
        district: "Dhaka",
        postalCode: "1207",
        isDefault: true,
      },
    });

    expect(saved.defaultAddress).not.toBeNull();
    expect(saved.defaultAddress?.fullName).toBe("Ayesha Rahman");
    expect(saved.defaultAddress?.postalCode).toBe("1207");
    expect(saved.defaultAddress?.addressLine2).toBe("Flat 3B");

    // And it survives a fresh read.
    const reread = await getCustomerProfile(customerId);

    expect(reread.defaultAddress?.city).toBe("Dhaka");
  });

  it("clears the delivery address when it is set to null", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_address_clear@example.com`);

    await updateCustomerProfile(customerId, {
      address: {
        fullName: "Ayesha Rahman",
        phone: "+8801712345678",
        addressLine1: "House 12, Road 5, Block C",
        city: "Dhaka",
        district: "Dhaka",
        postalCode: "1207",
        isDefault: true,
      },
    });

    const saved = await updateCustomerProfile(customerId, { address: null });

    expect(saved.defaultAddress).toBeNull();
  });

  it("writes to the caller's own row and to no other", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_own@example.com`);
    const otherId = await createCustomer(`${runId}_other@example.com`);

    await updateCustomerProfile(customerId, { name: "Only Mine Changed" });

    const other = await prisma.user.findUnique({
      where: { id: otherId },
      select: { name: true },
    });

    // The other customer is untouched.
    expect(other?.name).toBe("Test Customer");
  });

  it("never writes the role or the SMS consent", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_fixed@example.com`);

    await prisma.user.update({
      where: { id: customerId },
      data: { smsOptIn: false },
    });

    const saved = await updateCustomerProfile(customerId, {
      name: "Still A Customer",
    });

    // The role and the consent flag are read-only facts.
    expect(saved.smsOptIn).toBe(false);

    const row = await prisma.user.findUnique({
      where: { id: customerId },
      select: { role: true },
    });

    expect(row?.role).toBe("CUSTOMER");
  });
});

describe("the customer password change", () => {
  it("changes the password when the current one is right", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_pw@example.com`);

    await changeCustomerPassword(
      customerId,
      "the original password",
      "a much longer passphrase",
    );

    const row = await prisma.user.findUnique({
      where: { id: customerId },
      select: { passwordHash: true },
    });

    // The new password verifies against the stored hash.
    expect(
      await verifyPassword("a much longer passphrase", row?.passwordHash ?? ""),
    ).toBe(true);

    // And the old one does not.
    expect(
      await verifyPassword("the original password", row?.passwordHash ?? ""),
    ).toBe(false);
  });

  it("never stores the password in the clear", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_pw_hash@example.com`);

    await changeCustomerPassword(
      customerId,
      "the original password",
      "a much longer passphrase",
    );

    const row = await prisma.user.findUnique({
      where: { id: customerId },
      select: { passwordHash: true },
    });

    expect(row?.passwordHash).not.toContain("a much longer passphrase");
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it("refuses a change when the current password is wrong", async () => {
    if (!databaseAvailable) return;

    const customerId = await createCustomer(`${runId}_pw_wrong@example.com`);

    await expect(
      changeCustomerPassword(
        customerId,
        "not the current password",
        "a much longer passphrase",
      ),
    ).rejects.toBeInstanceOf(ApiError);

    // The stored password is untouched.
    const row = await prisma.user.findUnique({
      where: { id: customerId },
      select: { passwordHash: true },
    });

    expect(
      await verifyPassword("the original password", row?.passwordHash ?? ""),
    ).toBe(true);
  });

  it("refuses a change on an account that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      changeCustomerPassword(
        "no-such-customer-id",
        "the original password",
        "a much longer passphrase",
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
