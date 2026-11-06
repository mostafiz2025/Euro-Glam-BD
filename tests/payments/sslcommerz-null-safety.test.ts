import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allowsUnverifiedCallbacks,
  detectSslCommerzRail,
  isSslCommerzSandbox,
  validatePayment,
  validatePaymentBySessionKey,
} from "@/lib/sslcommerz";

/**
 * The SSLCOMMERZ gateway's null-safety, its rail detection, and its
 * sandbox guard rails.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * **1. A null or empty gateway body does not crash.**
 *
 * The bug this file exists for was a `TypeError: Cannot read properties
 * of null (reading 'status')` thrown several frames from its cause: the
 * transport legitimately returns `body: null` for an empty response, and
 * the caller cast that `null` to a non-null type, so the compiler never
 * forced a check. The crash surfaced in the callback handler, where the
 * stack trace pointed at a line that had done nothing wrong.
 *
 * The fix is not a null check bolted on at the throw site — it is an
 * honest type, so the compiler itself now refuses to let any access go
 * unchecked. These tests pin the behaviour that follows from it: a
 * missing body is "not verified", never a crash and never a
 * verification.
 *
 * **2. The rail is read from the gateway's own answer.**
 *
 * The checkout offers one "Online Payment" option that bundles bKash,
 * Nagad and cards, because the customer picks the operator on the
 * gateway's page — after the order exists. The gateway's validation
 * response names the method it actually used, and that is the only
 * trustworthy source. These tests pin how that name is read.
 *
 * **3. The sandbox fallback cannot weaken the live path.**
 *
 * The fallback settles a test order the gateway would not vouch for. It
 * is guarded on three fronts, and the third one is the important one:
 * setting the flag alone is **not** enough, because the shop must also
 * be in sandbox. A deployment that sets the flag carelessly still
 * cannot settle a real payment without the gateway's answer.
 */

/**
 * The original `fetch`, saved before any test replaces it.
 */
const realFetch = globalThis.fetch;

/**
 * The environment keys these tests touch.
 */
const KEYS = [
  "SSLCOMMERZ_STORE_ID",
  "SSLCOMMERZ_STORE_PASSWORD",
  "SSLCOMMERZ_IS_LIVE",
  "SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS",
] as const;

/**
 * Sets the environment for one test and restores it afterwards.
 */
function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();

  for (const key of KEYS) {
    previous.set(key, process.env[key]);
  }

  for (const key of KEYS) {
    const value = values[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const key of KEYS) {
      const value = previous.get(key);

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

/**
 * The credentials every test needs, so none of them is testing the
 * "missing credential" path by accident.
 */
const CREDENTIALS = {
  SSLCOMMERZ_STORE_ID: "eurog6ae43ef29ec0e",
  SSLCOMMERZ_STORE_PASSWORD: "eurog6ae43ef29ec0e@ssl",
} as const;

/**
 * A `fetch` that answers with a fixed body.
 */
function stubFetch(body: string): void {
  globalThis.fetch = vi.fn(
    async () => new Response(body, { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("a gateway that answers with nothing usable", () => {
  it("does NOT crash on an empty body", async () => {
    // ── The bug ────────────────────────────────────────────────────────
    //
    // An empty response body parses to `null`. The old code cast that
    // to a non-null type and then read `.status` off it, which is where
    // the `TypeError` came from.
    stubFetch("");

    const restore = withEnv({ ...CREDENTIALS, SSLCOMMERZ_IS_LIVE: "false" });

    try {
      const validation = await validatePayment("val-1");

      expect(validation.valid).toBe(false);
    } finally {
      restore();
    }
  });

  it("does NOT crash on a literal null body", async () => {
    stubFetch("null");

    const restore = withEnv({ ...CREDENTIALS, SSLCOMMERZ_IS_LIVE: "false" });

    try {
      const validation = await validatePayment("val-1");

      expect(validation.valid).toBe(false);
    } finally {
      restore();
    }
  });

  it("does NOT crash on an HTML body", async () => {
    // The gateway serves its SOAP documentation when it is confused
    // about the parameters it was given. That is a real answer, and it
    // is not a valid transaction.
    stubFetch("<html><body>NuSOAP: validationserverAPI</body></html>");

    const restore = withEnv({ ...CREDENTIALS, SSLCOMMERZ_IS_LIVE: "false" });

    try {
      const validation = await validatePayment("val-1");

      expect(validation.valid).toBe(false);
    } finally {
      restore();
    }
  });

  it("does NOT crash on a JSON array", async () => {
    // An array is an object, so a naive `typeof body === "object"` check
    // would let it through — and then `body.status` would be
    // `undefined`, which is a *different* wrong answer rather than the
    // same one.
    stubFetch("[1, 2, 3]");

    const restore = withEnv({ ...CREDENTIALS, SSLCOMMERZ_IS_LIVE: "false" });

    try {
      const validation = await validatePayment("val-1");

      expect(validation.valid).toBe(false);
      expect(validation.raw).toEqual({});
    } finally {
      restore();
    }
  });

  it("reports every field as absent, rather than half of them", async () => {
    // A partially-populated result would be worse than an empty one: the
    // caller would read `bankTransactionId: null` as "the gateway said
    // there is no bank transaction" rather than "the gateway said
    // nothing at all".
    stubFetch("");

    const restore = withEnv({ ...CREDENTIALS, SSLCOMMERZ_IS_LIVE: "false" });

    try {
      const validation = await validatePayment("val-1");

      expect(validation).toEqual({
        valid: false,
        raw: {},
        sessionKey: null,
        bankTransactionId: null,
        amountTaka: null,
        tranId: null,
        rail: null,
      });
    } finally {
      restore();
    }
  });

  it("survives the same empty body on the session-key path", async () => {
    // The second verification path has the same shape and must have the
    // same behaviour. If one was fixed and the other was not, the bug
    // would simply move.
    stubFetch("");

    const restore = withEnv({ ...CREDENTIALS, SSLCOMMERZ_IS_LIVE: "false" });

    try {
      const validation = await validatePaymentBySessionKey("session-1");

      expect(validation.valid).toBe(false);
      expect(validation.rail).toBeNull();
    } finally {
      restore();
    }
  });

  it("still reads a real answer normally", async () => {
    // The null-safety must not have cost the happy path.
    stubFetch(
      JSON.stringify({
        status: "VALID_TRANSACTION",
        amount: "580.00",
        bank_tran_id: "BANK-1",
        tran_id: "EGB-1",
        card_type: "BKASH",
      }),
    );

    const restore = withEnv({ ...CREDENTIALS, SSLCOMMERZ_IS_LIVE: "false" });

    try {
      const validation = await validatePayment("val-1");

      expect(validation.valid).toBe(true);
      expect(validation.amountTaka).toBe(580);
      expect(validation.bankTransactionId).toBe("BANK-1");
      expect(validation.tranId).toBe("EGB-1");
      expect(validation.rail).toBe("BKASH");
    } finally {
      restore();
    }
  });
});

describe("reading the rail off the gateway's answer", () => {
  it("reads bKash", () => {
    expect(detectSslCommerzRail("BKASH")).toBe("BKASH");
    expect(detectSslCommerzRail("bKash")).toBe("BKASH");
    expect(detectSslCommerzRail("BKASH Mobile Wallet")).toBe("BKASH");
  });

  it("reads Nagad", () => {
    expect(detectSslCommerzRail("NAGAD")).toBe("NAGAD");
    expect(detectSslCommerzRail("Nagad")).toBe("NAGAD");
    expect(detectSslCommerzRail("Nagad Mobile Banking")).toBe("NAGAD");
  });

  it("reads everything else as a card", () => {
    // A card is the generic case, so it is the default — but only when
    // the gateway said *something*.
    expect(detectSslCommerzRail("VISA")).toBe("CARD");
    expect(detectSslCommerzRail("MASTERCARD")).toBe("CARD");
    expect(detectSslCommerzRail("AMEX")).toBe("CARD");
  });

  it("reads nothing from a missing or blank card type", () => {
    // `null` means "the gateway did not say", which is different from
    // "the gateway said it was a card". The order row keeps whatever it
    // already had, rather than being overwritten with a guess.
    expect(detectSslCommerzRail(undefined)).toBeNull();
    expect(detectSslCommerzRail("")).toBeNull();
    expect(detectSslCommerzRail("   ")).toBeNull();
  });

  it("tolerates the casing and padding the gateway actually sends", () => {
    expect(detectSslCommerzRail("  bkash  ")).toBe("BKASH");
    expect(detectSslCommerzRail("nagad")).toBe("NAGAD");
  });
});

describe("the sandbox fallback's guard rails", () => {
  it("is off by default", () => {
    // The default is the safe one: an unverified payment settles only
    // when someone has deliberately asked for it.
    const restore = withEnv({ ...CREDENTIALS });

    try {
      expect(allowsUnverifiedCallbacks()).toBe(false);
    } finally {
      restore();
    }
  });

  it("is on when the flag is set and the shop is in sandbox", () => {
    const restore = withEnv({
      ...CREDENTIALS,
      SSLCOMMERZ_IS_LIVE: "false",
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "true",
    });

    try {
      expect(allowsUnverifiedCallbacks()).toBe(true);
    } finally {
      restore();
    }
  });

  it("is REFUSED when the shop is live, however the flag is set", () => {
    // ── The guard that matters most ────────────────────────────────────
    //
    // The flag is not sufficient on its own. A live shop ignores it
    // completely, so a deployment that sets it carelessly still cannot
    // settle a real payment without the gateway's answer.
    const restore = withEnv({
      ...CREDENTIALS,
      SSLCOMMERZ_IS_LIVE: "true",
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "true",
    });

    try {
      expect(allowsUnverifiedCallbacks()).toBe(false);
    } finally {
      restore();
    }
  });

  it("reads the flag strictly, so a typo leaves it off", () => {
    // A typo must fail **safe**. The fallback settles payments without
    // the gateway's answer, so "probably on" is not an acceptable
    // reading of "yes", "1" or "true-ish".
    for (const value of ["yes", "1", "on", "enabled", "truthy", "ture"]) {
      const restore = withEnv({
        ...CREDENTIALS,
        SSLCOMMERZ_IS_LIVE: "false",
        SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: value,
      });

      try {
        expect(allowsUnverifiedCallbacks()).toBe(false);
      } finally {
        restore();
      }
    }
  });

  it("ignores the case and the padding around the flag", () => {
    // A `.env` value with a stray space or a capital T is a formatting
    // accident, not a request for a different behaviour — and reading
    // it as "off" would send the developer back to the endless
    // "we could not confirm" loop the flag exists to break.
    for (const value of ["true", "TRUE", "True", " true ", "\ttrue\n"]) {
      const restore = withEnv({
        ...CREDENTIALS,
        SSLCOMMERZ_IS_LIVE: "false",
        SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: value,
      });

      try {
        expect(allowsUnverifiedCallbacks()).toBe(true);
      } finally {
        restore();
      }
    }
  });

  it("treats the live switch the same strict way", () => {
    // "TRUE" is the live switch — the same word the store configuration
    // reads — so the two switches must agree about what "true" means.
    const restore = withEnv({
      ...CREDENTIALS,
      SSLCOMMERZ_IS_LIVE: "TRUE",
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "true",
    });

    try {
      expect(isSslCommerzSandbox()).toBe(false);
      expect(allowsUnverifiedCallbacks()).toBe(false);
    } finally {
      restore();
    }
  });

  it("treats an absent live switch as sandbox", () => {
    // The shop defaults to the sandbox, so a developer who set only the
    // fallback flag gets the fallback — and a developer who set only the
    // live switch is protected.
    const restore = withEnv({
      ...CREDENTIALS,
      SSLCOMMERZ_IS_LIVE: undefined,
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "true",
    });

    try {
      expect(isSslCommerzSandbox()).toBe(true);
      expect(allowsUnverifiedCallbacks()).toBe(true);
    } finally {
      restore();
    }
  });
});
