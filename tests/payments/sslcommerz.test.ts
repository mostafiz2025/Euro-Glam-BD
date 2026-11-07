import { describe, expect, it } from "vitest";

import {
  buildCallbackUrls,
  getSslCommerzConfig,
  paisaToTaka,
  SSLCOMMERZ_COUNTRY,
  SSLCOMMERZ_CURRENCY,
  SSLCOMMERZ_PRODUCT_CATEGORY,
  SSLCOMMERZ_PRODUCT_PROFILE,
  SSLCOMMERZ_SHIPPING_METHOD,
} from "@/lib/sslcommerz";

/**
 * The SSLCOMMERZ gateway's pure logic.
 *
 * These need no database and no network, because the facts they check are
 * facts about *shape*: the currency, the callback URLs, the poisha
 * arithmetic, and the way a missing credential or a mistyped live switch
 * is handled.
 *
 * The last two are the canaries. A missing credential must fail **loudly**
 * — a deployment that looks healthy while every payment fails is the
 * worst outcome available — and the live switch must fail **safe**, so a
 * typo points at the sandbox rather than at the live gateway where money
 * is real.
 */
describe("the gateway's constants", () => {
  it("settles in Bangladeshi taka", () => {
    // One constant, because "BDT" written in three places is three
    // places to forget it.
    expect(SSLCOMMERZ_CURRENCY).toBe("BDT");
  });

  it("declares a physical-goods profile, because the shop ships", () => {
    expect(SSLCOMMERZ_PRODUCT_PROFILE).toBe("physical-goods");
    expect(SSLCOMMERZ_SHIPPING_METHOD).toBe("Courier");
    expect(SSLCOMMERZ_COUNTRY).toBe("Bangladesh");
    expect(SSLCOMMERZ_PRODUCT_CATEGORY).toBe("General Merchandise");
  });
});

describe("converting poisha to taka", () => {
  it("divides by one hundred", () => {
    expect(paisaToTaka(100)).toBe(1);
    expect(paisaToTaka(24_000)).toBe(240);
  });

  it("rounds **down**, never up", () => {
    // Rounding up would charge the customer more than the order is
    // worth, and a shop that overcharges by one taka on every order does
    // not keep that shop.
    expect(paisaToTaka(199)).toBe(1);
    expect(paisaToTaka(101)).toBe(1);
    expect(paisaToTaka(150)).toBe(1);
  });

  it("sends a sub-taka amount to zero rather than to a negative", () => {
    expect(paisaToTaka(50)).toBe(0);
    expect(paisaToTaka(0)).toBe(0);
  });
});

describe("the callback URLs", () => {
  it("builds all four from the configured base URL", () => {
    const urls = buildCallbackUrls();

    expect(urls.successUrl).toMatch(/\/payment\/success$/);
    expect(urls.failUrl).toMatch(/\/payment\/fail$/);
    expect(urls.cancelUrl).toMatch(/\/payment\/cancel$/);
    expect(urls.ipnUrl).toMatch(/\/payment\/ipn$/);
  });

  it("strips a trailing slash from the base URL", () => {
    // A base URL of `https://shop.test/` would otherwise produce
    // `https://shop.test//payment/success` — a URL that works, but one
    // that no longer matches what the gateway was configured with.
    const previous = process.env.NEXT_PUBLIC_SITE_URL;

    try {
      process.env.NEXT_PUBLIC_SITE_URL = "https://shop.test/";
      expect(buildCallbackUrls().successUrl).toBe(
        "https://shop.test/payment/success",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_SITE_URL;
      } else {
        process.env.NEXT_PUBLIC_SITE_URL = previous;
      }
    }
  });

  it("builds absolute URLs, because the customer's browser resolves them", () => {
    // A relative path would be meaningless to the gateway, which fetches
    // the callback from its own server.
    const previous = process.env.NEXT_PUBLIC_SITE_URL;

    try {
      process.env.NEXT_PUBLIC_SITE_URL = "https://euro-glam-bd.vercel.app";
      const urls = buildCallbackUrls();

      for (const url of Object.values(urls)) {
        expect(url.startsWith("https://")).toBe(true);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_SITE_URL;
      } else {
        process.env.NEXT_PUBLIC_SITE_URL = previous;
      }
    }
  });
});

describe("the store configuration", () => {
  /**
   * The environment keys the config reads, saved and restored around each
   * test so the suite cannot leak state into the other tests in this file
   * — or into the integration project, which shares the same process.
   */
  const KEYS = [
    "SSLCOMMERZ_STORE_ID",
    "SSLCOMMERZ_STORE_PASSWORD",
    "SSLCOMMERZ_IS_LIVE",
  ] as const;

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

  it("reads the store credentials", () => {
    const restore = withEnv({
      SSLCOMMERZ_STORE_ID: "eurog6ae43ef29ec0e",
      SSLCOMMERZ_STORE_PASSWORD: "eurog6ae43ef29ec0e@ssl",
      SSLCOMMERZ_IS_LIVE: "false",
    });

    try {
      const config = getSslCommerzConfig();

      expect(config.storeId).toBe("eurog6ae43ef29ec0e");
      expect(config.storePassword).toBe("eurog6ae43ef29ec0e@ssl");
      expect(config.isLive).toBe(false);
    } finally {
      restore();
    }
  });

  it("fails loudly when the credentials are missing", () => {
    // A missing credential is a deployment error. A silent fallback would
    // let the deployment look healthy while every payment failed.
    const restore = withEnv({
      SSLCOMMERZ_STORE_ID: undefined,
      SSLCOMMERZ_STORE_PASSWORD: undefined,
    });

    try {
      expect(() => getSslCommerzConfig()).toThrowError(
        /SSLCOMMERZ_STORE_ID/,
      );
    } finally {
      restore();
    }
  });

  it("fails loudly when only one of the two credentials is present", () => {
    const restore = withEnv({
      SSLCOMMERZ_STORE_ID: "eurog6ae43ef29ec0e",
      SSLCOMMERZ_STORE_PASSWORD: undefined,
    });

    try {
      expect(() => getSslCommerzConfig()).toThrowError();
    } finally {
      restore();
    }
  });

  it("treats a blank credential as missing", () => {
    // A key that is present but empty is not a credential. Accepting it
    // would send `store_passwd=""` to the gateway and get a confusing
    // rejection instead of a clear "not configured".
    const restore = withEnv({
      SSLCOMMERZ_STORE_ID: "eurog6ae43ef29ec0e",
      SSLCOMMERZ_STORE_PASSWORD: "   ",
    });

    try {
      expect(() => getSslCommerzConfig()).toThrowError();
    } finally {
      restore();
    }
  });

  it("reads the live switch strictly, so a typo fails safe into the sandbox", () => {
    // "the one-word change that must never happen by accident". A typo
    // therefore points at the sandbox — where nothing can be charged —
    // rather than failing open into the live gateway.
    for (const value of ["true", "TRUE", "True"]) {
      const restore = withEnv({
        SSLCOMMERZ_STORE_ID: "id",
        SSLCOMMERZ_STORE_PASSWORD: "password",
        SSLCOMMERZ_IS_LIVE: value,
      });

      try {
        expect(getSslCommerzConfig().isLive).toBe(true);
      } finally {
        restore();
      }
    }

    for (const value of ["false", "FALSE", "yes", "1", "live", "tru", ""]) {
      const restore = withEnv({
        SSLCOMMERZ_STORE_ID: "id",
        SSLCOMMERZ_STORE_PASSWORD: "password",
        SSLCOMMERZ_IS_LIVE: value,
      });

      try {
        expect(getSslCommerzConfig().isLive).toBe(false);
      } finally {
        restore();
      }
    }
  });

  it("defaults to the sandbox when the live switch is absent entirely", () => {
    const restore = withEnv({
      SSLCOMMERZ_STORE_ID: "id",
      SSLCOMMERZ_STORE_PASSWORD: "password",
      SSLCOMMERZ_IS_LIVE: undefined,
    });

    try {
      expect(getSslCommerzConfig().isLive).toBe(false);
    } finally {
      restore();
    }
  });
});
