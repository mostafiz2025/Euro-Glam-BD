import "dotenv/config";

/**
 * A diagnostic: how much credit does the OpenRouter key have left?
 *
 * ── Why this is worth knowing ────────────────────────────────────────────
 *
 * A live run failed with:
 *
 * > This request requires more credits, or fewer max_tokens. You requested
 * > up to 131072 tokens, but can only afford 34923.
 *
 * That message conflates two things: a genuinely exhausted balance, and a
 * request that did not state its own size. The advisor's reply is a few
 * hundred tokens, but with no `max_tokens` on the body OpenRouter
 * reserves the model's whole context window against the remaining credit
 * — and the request is refused.
 *
 * So the credit number alone does not say whether the shop can run. What
 * matters is whether the balance covers a request that states its own
 * ceiling.
 *
 * Run it with:
 *
 *   npx tsx scripts/probe-credits.ts
 */

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set.");
    process.exitCode = 1;
    return;
  }

  const response = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const text = await response.text();

  console.log(`HTTP ${response.status}`);

  try {
    const parsed = JSON.parse(text) as {
      data?: {
        total_credits?: number;
        total_usage?: number;
        remaining_credits?: number;
      };
    };

    const data = parsed.data ?? {};

    console.log(`total credits    : ${data.total_credits ?? "?"}`);
    console.log(`total usage      : ${data.total_usage ?? "?"}`);

    // OpenRouter does not always populate `remaining_credits`; when it is
    // absent the balance is the credited amount minus what has been spent.
    const remaining =
      typeof data.remaining_credits === "number"
        ? data.remaining_credits
        : typeof data.total_credits === "number" && typeof data.total_usage === "number"
          ? data.total_credits - data.total_usage
          : null;

    if (remaining === null) {
      console.log(`remaining credits: ?`);
    } else {
      console.log(`remaining credits: ${remaining}`);
      if (remaining <= 0) {
        // A key with no purchased credit is not necessarily broken. The
        // `:free` model tiers are served without a balance, so a zero
        // balance is normal for a free model and the advisor keeps
        // working. What a zero balance *does* mean is that a paid model
        // will be refused with a 402 — there is nothing left to reserve
        // the request's `max_tokens` against.
        console.log("");
        console.log("No purchased credit on this key. A paid model would be");
        console.log("refused with HTTP 402; a `:free` model tier is still served.");
        console.log("Check the live call with `npm run verify:openrouter`.");
      }
    }
  } catch {
    console.log(text.slice(0, 500));
  }
}

main().catch((error: unknown) => {
  console.error("The probe failed:", error);
  process.exitCode = 1;
});
