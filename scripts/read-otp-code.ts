import { PrismaClient } from "@prisma/client";

/**
 * Reads the most recent one-time-password row for an address.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The code is stored only as a salted hash, so it cannot be read back out
 * of the database — which is the whole point of hashing it. But the
 * **mail** that carried it can be captured, and the code can be recovered
 * from the message.
 *
 * So this script does not read the code. It reads the row, and it
 * prints the row's id, purpose, expiry and attempts — enough to confirm
 * that the right code was issued, for the right purpose, and that it is
 * still live. The code itself is printed by the mail capture.
 *
 * It exists for the integration tests and for manual verification of the
 * flow, and it is deliberately not a way to learn a customer's code.
 */
const db = new PrismaClient();

async function main(): Promise<void> {
  const email = process.argv[2];

  if (!email) {
    console.error("Usage: tsx scripts/read-otp-code.ts <email>");
    process.exitCode = 1;
    return;
  }

  const rows = await db.emailOtp.findMany({
    where: { email: email.toLowerCase() },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      purpose: true,
      expiresAt: true,
      attempts: true,
      createdAt: true,
      codeHash: true,
    },
  });

  if (rows.length === 0) {
    console.log(`No live code for ${email}.`);
    return;
  }

  for (const row of rows) {
    const live = row.expiresAt.getTime() > Date.now();

    console.log(`id        ${row.id}`);
    console.log(`email     ${row.email}`);
    console.log(`purpose   ${row.purpose}`);
    console.log(`attempts  ${row.attempts}`);
    console.log(`live      ${live ? "yes" : "no — expired"}`);
    console.log(`hash      ${row.codeHash.slice(0, 16)}…`);
    console.log("");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
