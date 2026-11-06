import { PrismaClient } from "@prisma/client";

/**
 * Marks the accounts that already existed as verified.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The `emailVerifiedAt` column arrived with the registration-verification
 * flow. Every account created before it has `emailVerifiedAt: null`, which
 * means "never verified" — and an unverified account cannot sign in.
 *
 * Those accounts were created by the operator, who already checked the
 * address, and they include the seeded administrator and the demo
 * customer. Leaving them unverified would lock the shop out of its own
 * dev data, and would make the seeded admin unable to reach the console.
 *
 * This is a **one-off** for the existing development database. New
 * accounts are verified by the code that mails them a code, and the
 * seed script sets the flag for the accounts it creates.
 *
 * It is deliberately a script and not a migration. A migration that
 * backfilled the column would have made every account ever created look
 * verified — including, in a real deployment, every account that had
 * registered and never confirmed. The distinction is the whole point of
 * the column.
 */
const db = new PrismaClient();

async function main(): Promise<void> {
  const updated = await db.user.updateMany({
    where: { emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });

  console.log(`Marked ${updated.count} existing accounts as verified.`);

  const users = await db.user.findMany({
    select: { email: true, role: true, emailVerifiedAt: true },
    orderBy: { email: "asc" },
  });

  for (const user of users) {
    console.log(
      `  ${user.email.padEnd(36)} ${user.role.padEnd(9)} ${user.emailVerifiedAt ? "verified" : "UNVERIFIED"}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
