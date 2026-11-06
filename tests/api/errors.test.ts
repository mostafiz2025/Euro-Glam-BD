import { describe, expect, it } from "vitest";

import { handleApiError } from "@/lib/api/errors";
import { AiProviderError } from "@/lib/ai/provider";

/**
 * The API error handler.
 *
 * The Prisma error-code mappings are the rules under test, because they
 * are the difference between a **conflict** and a **crash**:
 *
 *   • `P2002` — a unique-constraint violation. A duplicate email, a
 *     duplicate slug. The request was reasonable; the record already
 *     exists. → 409.
 *   • `P2003` — a foreign-key violation. A write would leave a
 *     dangling reference. The classic case is a hard delete of a
 *     product that gained an order item between the service's check
 *     and the delete. The request was reasonable; the world moved
 *     underneath it. → 409, with a message that names the remedy.
 *   • `P2025` — "record not found". → 404.
 *   • `P2034` — a transaction conflict. Transient by definition: the
 *     same transaction submitted again will usually succeed. → 409.
 *
 * Without these mappings, every one of them would fall through to a
 * generic 500 "Something went wrong" — which tells the admin nothing
 * and makes a routine race look like an outage.
 */

/**
 * Builds a Prisma-shaped error with the given code.
 */
function prismaError(code: string): Error {
  return Object.assign(new Error("Prisma error"), { code });
}

describe("handleApiError — the Prisma code mappings", () => {
  it("maps a unique-constraint violation to 409", async () => {
    const response = handleApiError(prismaError("P2002"));

    expect(response.status).toBe(409);

    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toBe("That record already exists.");
  });

  it("maps a foreign-key violation to 409 with the archive remedy", async () => {
    const response = handleApiError(prismaError("P2003"));

    expect(response.status).toBe(409);

    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFLICT");

    // The message names the remedy. A 409 that says only "conflict" is
    // a support ticket; a 409 that says what to do instead is a fix.
    expect(body.error.message).toContain("Archive it instead");
  });

  it("maps a record-not-found to 404", async () => {
    const response = handleApiError(prismaError("P2025"));

    expect(response.status).toBe(404);

    const body = await response.json();

    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("maps a transaction conflict to 409 and asks the caller to retry", async () => {
    const response = handleApiError(prismaError("P2034"));

    expect(response.status).toBe(409);

    const body = await response.json();

    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("try again");
  });

  it("maps an unrecognised error to a generic 500", async () => {
    const response = handleApiError(new Error("something broke"));

    expect(response.status).toBe(500);

    const body = await response.json();

    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("never leaks the underlying message to the client", async () => {
    const response = handleApiError(
      new Error("connection to 10.0.0.5:5432 refused"),
    );

    const body = await response.json();

    // The stack trace and the database error stay on the server. The
    // client learns that something went wrong, and nothing more.
    expect(body.error.message).not.toContain("10.0.0.5");
    expect(body.error.message).toBe("Something went wrong. Please try again.");
  });
});

/**
 * The AI provider failure.
 *
 * The provider is **upstream of us**. When it breaks, the customer's
 * request was perfectly reasonable and the application did nothing wrong
 * — so the answer must be a 502, not a 500.
 *
 * A 500 says "this application is broken" and pages somebody. A 502 says
 * "upstream is broken, retry later" and does not. Getting this wrong is
 * not a cosmetic difference: it is the difference between a noisy night
 * and a quiet one.
 *
 * The `AI_PROVIDER_ERROR` code existed in the union and was already
 * mapped to 502 — but nothing threw it, so every provider failure fell
 * through to the generic 500. These tests pin the mapping that was
 * missing.
 */
describe("handleApiError — the AI provider failure", () => {
  it("maps a provider failure to 502", async () => {
    const response = handleApiError(
      new AiProviderError("gemini", "The AI provider returned an empty response."),
    );

    expect(response.status).toBe(502);

    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("AI_PROVIDER_ERROR");
  });

  it("does not report a provider failure as an internal error", async () => {
    const response = handleApiError(
      new AiProviderError("openrouter", "upstream refused the connection"),
    );

    const body = await response.json();

    // A 500 would say the shop is broken. The shop is not broken.
    expect(body.error.code).not.toBe("INTERNAL_ERROR");
    expect(response.status).not.toBe(500);
  });

  it("tells the customer to try again rather than that something broke", async () => {
    const response = handleApiError(
      new AiProviderError("gemini", "The AI provider returned an empty response."),
    );

    const body = await response.json();

    expect(body.error.message).toContain("try again");
    expect(body.error.message).not.toBe("Something went wrong. Please try again.");
  });

  it("never leaks the provider's own message to the client", async () => {
    const response = handleApiError(
      new AiProviderError(
        "openrouter",
        "quota exceeded for model anthropic/claude with key sk-live-abc123",
      ),
    );

    const body = await response.json();

    // The provider name, the model and the key fragment stay in the log.
    // The customer learns the advisor is busy and nothing more.
    expect(body.error.message).not.toContain("quota");
    expect(body.error.message).not.toContain("sk-live");
    expect(body.error.message).not.toContain("claude");
  });

  it("keeps the provider error recognisable through the cause chain", () => {
    const cause = new Error("socket hang up");

    const error = new AiProviderError("gemini", "request failed", cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AiProviderError");
    expect(error.providerName).toBe("gemini");
    expect(error.cause).toBe(cause);
  });
});
