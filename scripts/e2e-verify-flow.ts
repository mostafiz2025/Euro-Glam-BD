/**
 * A live end-to-end check of the registration → verification flow.
 *
 * ── What this proves ──────────────────────────────────────────────────────
 *
 * The unit and integration suites cover each rule in isolation. This
 * script covers the **journey**, against the running server and the real
 * database:
 *
 *   1. Registering creates an account and issues **no session**.
 *   2. The verification code verifies the account.
 *   3. The verification response carries a session cookie.
 *   4. That session actually works — the cart and `/api/auth/me` answer.
 *   5. The same code cannot be spent twice.
 *   6. A sign-in code cannot verify an account.
 *
 * ── How the code is obtained ──────────────────────────────────────────────
 *
 * The code is stored only as a salted hash, so it cannot be read back out
 * of the table — that is the point of hashing it. The **mail** carries the
 * code, but the server mails it to a real inbox that this script cannot
 * read.
 *
 * So the script does what `scripts/capture-otp.ts` does: it writes the
 * same row the service would have written — same hash, same salt, same
 * expiry, same purpose — and keeps the code it minted. The verification
 * path it feeds is the real one: the code is hashed with the row's id and
 * compared in constant time, exactly as it is for a code that arrived by
 * mail.
 *
 * Run with: `npx tsx scripts/e2e-verify-flow.ts`
 */

import { OtpPurpose, PrismaClient } from "@prisma/client";

import { generateOtpCode, hashCode } from "@/lib/auth/otp";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const db = new PrismaClient();

const runId = `e2e${Date.now()}`;
const EMAIL = `${runId}@example.com`;
const OTHER_EMAIL = `${runId}_other@example.com`;
const PASSWORD = "correct-horse-battery";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}`);
  }
}

/**
 * Mints a code and writes the row the service would have written.
 *
 * @returns The code, which the caller can now present.
 */
async function mintCode(
  email: string,
  purpose: OtpPurpose,
): Promise<string> {
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) throw new Error(`No account at ${email}.`);

  const code = generateOtpCode();
  const id = crypto.randomUUID().replace(/-/g, "");

  await db.emailOtp.deleteMany({ where: { email, purpose } });

  await db.emailOtp.create({
    data: {
      id,
      userId: user.id,
      purpose,
      codeHash: hashCode(code, id),
      email,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
    },
  });

  return code;
}

/**
 * The envelope the auth routes answer with.
 *
 * Only the fields this script reads are typed; the rest of the body is
 * not interesting here.
 */
type AuthPayload = {
  ok?: boolean;
  data?: {
    user?: { id?: string; email?: string; emailVerified?: boolean };
    verificationSent?: boolean;
    firstVerification?: boolean;
  };
  error?: { code?: string; message?: string };
};

/**
 * Posts JSON and returns the response, its body and the session cookie.
 */
async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; payload: AuthPayload | null; cookie: string | null }> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  });

  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie ? (setCookie.split(";")[0] ?? null) : null;

  let payload: AuthPayload | null = null;

  try {
    payload = (await response.json()) as AuthPayload;
  } catch {
    payload = null;
  }

  return { status: response.status, payload, cookie };
}

async function main(): Promise<void> {
  console.log(`\n── Live check: registration → verification (${EMAIL}) ──\n`);

  /* ── 1. Registration issues no session ─────────────────────────────── */
  console.log("1. Registration creates the account and issues no session");

  const registered = await post("/api/auth/register", {
    name: "E2E Tester",
    email: EMAIL,
    password: PASSWORD,
  });

  check("it answers 201", registered.status === 201);
  check(
    "the account is reported unverified",
    registered.payload?.data?.user?.emailVerified === false,
  );
  check("no session cookie was written", registered.cookie === null);

  const account = await db.user.findUnique({
    where: { email: EMAIL },
    select: { id: true, emailVerifiedAt: true, role: true },
  });

  check("the account exists", account !== null);
  check("the stored account is unverified", account?.emailVerifiedAt === null);
  check("the account is a CUSTOMER", account?.role === "CUSTOMER");

  /* ── 2. The code verifies the account ─────────────────────────────── */
  console.log("\n2. The mailed code verifies the account");

  const code = await mintCode(EMAIL, OtpPurpose.SIGNUP);

  const verified = await post("/api/auth/verify-otp", {
    email: EMAIL,
    code,
    purpose: OtpPurpose.SIGNUP,
  });

  check("it answers 200", verified.status === 200);
  check(
    "the account is now verified",
    verified.payload?.data?.user?.emailVerified === true,
  );
  check(
    "it claims the first verification",
    verified.payload?.data?.firstVerification === true,
  );
  check("a session cookie was written", verified.cookie !== null);
  check(
    "the cookie is the session cookie",
    verified.cookie?.startsWith("egb_session=") === true,
  );

  const afterVerification = await db.user.findUnique({
    where: { email: EMAIL },
    select: { emailVerifiedAt: true },
  });

  check("the timestamp is stored", afterVerification?.emailVerifiedAt !== null);

  /* ── 3. The session works ─────────────────────────────────────────── */
  console.log("\n3. The session that was issued actually works");

  const cart = await fetch(`${BASE}/api/cart`, {
    headers: { cookie: verified.cookie ?? "" },
  });

  check("the cart answers 200", cart.status === 200);

  const me = await fetch(`${BASE}/api/auth/me`, {
    headers: { cookie: verified.cookie ?? "" },
  });

  const meBody = (await me.json()) as { data?: { user?: { email?: string } } };

  check(
    "the session identifies the customer",
    meBody.data?.user?.email === EMAIL,
  );

  /* ── 4. The code cannot be spent twice ────────────────────────────── */
  console.log("\n4. The same code cannot be spent twice");

  const replayed = await post("/api/auth/verify-otp", {
    email: EMAIL,
    code,
    purpose: OtpPurpose.SIGNUP,
  });

  check("the replay is refused with 401", replayed.status === 401);
  check("no session is written for a replay", replayed.cookie === null);

  /* ── 5. A sign-in code cannot verify an account ───────────────────── */
  console.log("\n5. A sign-in code cannot verify an account");

  const other = await post("/api/auth/register", {
    name: "E2E Other",
    email: OTHER_EMAIL,
    password: PASSWORD,
  });

  check("the second account was created", other.status === 201);

  const signInCode = await mintCode(OTHER_EMAIL, OtpPurpose.SIGNIN);

  const crossed = await post("/api/auth/verify-otp", {
    email: OTHER_EMAIL,
    code: signInCode,
    purpose: OtpPurpose.SIGNIN,
  });

  /*
   * A SIGNIN code presented for an unverified account must not sign it
   * in. The account is still unverified, so the route refuses it — and
   * the refusal must come before any session is minted.
   */
  check(
    "the sign-in purpose is refused for an unverified account",
    crossed.status === 403,
  );
  check("no session is written", crossed.cookie === null);

  const otherAccount = await db.user.findUnique({
    where: { email: OTHER_EMAIL },
    select: { emailVerifiedAt: true },
  });

  check("the account is still unverified", otherAccount?.emailVerifiedAt === null);

  console.log(`\n${passed} passed, ${failed} failed\n`);
}

async function cleanup(): Promise<void> {
  try {
    await db.emailOtp.deleteMany({ where: { email: { contains: runId } } });
    await db.emailOtpAttempt.deleteMany({ where: { email: { contains: runId } } });
    await db.cart.deleteMany({ where: { user: { email: { contains: runId } } } });
    await db.user.deleteMany({ where: { email: { contains: runId } } });
  } finally {
    await db.$disconnect();
  }
}

main()
  .then(cleanup)
  .catch(async (error: unknown) => {
    console.error(error);
    await cleanup();
    process.exitCode = 1;
  });
