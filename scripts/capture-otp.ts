import { OtpPurpose, PrismaClient } from "@prisma/client";

import { generateOtpCode, hashCode } from "@/lib/auth/otp";

/**
 * Issues a one-time password **directly in the database** and prints it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The one-time password is stored only as a salted hash — that is the
 * point of hashing it — so the code cannot be read back out of the
 * table. But it can be recovered from the **mail**, and the mail cannot
 * be read from a development machine whose SMTP credentials point at a
 * real inbox.
 *
 * This script does the third thing: it mints a code, writes the same
 * row the service would have written, and prints the code. The row it
 * writes is indistinguishable from a real one — same hash, same salt,
 * same expiry, same purpose.
 *
 * It is a **development** tool. It writes a live credential, so it must
 * never be run against a real database. The guard below refuses to run
 * when `NODE_ENV` is `production`, and it prints a warning every time.
 *
 * The verification path it feeds is the real one: the code is hashed
 * with the row's id and compared in constant time, exactly as it is for
 * a code that arrived by mail.
 */
const db = new PrismaClient();

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error(
      "Refusing to run: this writes a live credential and must not run in production.",
    );
    process.exitCode = 1;
    return;
  }

  const email = (process.argv[2] ?? "").trim().toLowerCase();
  const requested = (process.argv[3] ?? "SIGNIN").toUpperCase();

  if (!email) {
    console.error("Usage: tsx scripts/capture-otp.ts <email> [SIGNIN|SIGNUP]");
    process.exitCode = 1;
    return;
  }

  if (requested !== OtpPurpose.SIGNIN && requested !== OtpPurpose.SIGNUP) {
    console.error("The purpose must be SIGNIN or SIGNUP.");
    process.exitCode = 1;
    return;
  }

  const purpose: OtpPurpose = requested;

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, emailVerifiedAt: true },
  });

  if (!user) {
    console.error(`No account at ${email}.`);
    process.exitCode = 1;
    return;
  }

  /*
   * The same two refusals the service makes.
   *
   * A SIGNUP code for an already-verified account, or a SIGNIN code for
   * an unverified one, is a row the service would never write. Minting
   * one here would produce a credential that verifies an account by a
   * path the real system does not have — which is exactly the kind of
   * false confidence a debugging tool should not create.
   */
  const isVerified = user.emailVerifiedAt !== null;

  if (purpose === OtpPurpose.SIGNUP && isVerified) {
    console.error(`The account at ${email} is already verified.`);
    process.exitCode = 1;
    return;
  }

  if (purpose === OtpPurpose.SIGNIN && !isVerified) {
    console.error(
      `The account at ${email} has not been verified yet — a SIGNUP code is needed first.`,
    );
    process.exitCode = 1;
    return;
  }

  const code = generateOtpCode();
  const id = crypto.randomUUID().replace(/-/g, "");

  await db.emailOtp.deleteMany({ where: { email, purpose } });

  await db.emailOtp.create({
    data: {
      id,
      userId: user.id,
      purpose,
      codeHash: hashCode(code, id),
      email: user.email,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
    },
  });

  console.log(code);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
