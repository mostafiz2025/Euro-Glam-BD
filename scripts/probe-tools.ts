import "dotenv/config";

/**
 * A diagnostic: does an OpenRouter model emit tool calls?
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The advisor needs the product ids back from the model. In the
 * OpenAI-compatible dialect there are two channels for that: the
 * `[RECOMMENDED: …]` marker line in the prose, and a structured
 * `tool_calls` entry.
 *
 * A live conversation check showed the marker being **dropped** — the
 * model recommended both products in prose and never wrote the line, so
 * no product cards attached in the shop.
 *
 * The remedy is the tool-call channel, but only if the configured model
 * actually supports it. OpenRouter routes to many upstream providers,
 * and a model that does not support tools either ignores the `tools`
 * array or fails the request outright. Neither is knowable without
 * asking, and a deployment pointed at such a model would break.
 *
 * Run it with:
 *
 *   npx tsx scripts/probe-tools.ts
 *   npx tsx scripts/probe-tools.ts some/model-id another/model-id
 *
 * With no arguments it probes the model named by `OPENROUTER_MODEL`.
 *
 * It needs `OPENROUTER_API_KEY` in the environment. It does not write to
 * the database, and it does not touch the storefront.
 */

/**
 * Probes one model and reports whether it emitted a tool call.
 */
async function probe(model: string): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) {
    console.error(
      "OPENROUTER_API_KEY is not set. Add it to .env and try again.",
    );
    process.exitCode = 1;
    return;
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.NEXT_PUBLIC_SITE_URL?.trim()
          ? { "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL.trim() }
          : {}),
        "X-Title": process.env.OPENROUTER_TITLE?.trim() ?? "Euro Glam BD",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content:
              "You recommended the Niacinamide 10% Serum to the customer. Report it.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "recommend_products",
              description:
                "Report which products you recommended. Call this with an empty list when you recommended none.",
              parameters: {
                type: "object",
                properties: {
                  productIds: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "The ids of the products you recommended. Every id must be one of the ids in the candidate list. Use an empty list when you recommended nothing.",
                  },
                },
                required: ["productIds"],
              },
            },
          },
        ],
        provider: { allow_fallbacks: true },
        // The probe must state its own ceiling. Without one, OpenRouter
        // reserves the model's whole context window against the account's
        // credit and refuses the request with a 402 — which says nothing
        // about tool support and makes this probe lie.
        max_tokens: 1200,
      }),
    },
  );

  const body = await response.text();

  console.log(`\n=== ${model}`);
  console.log(`HTTP ${response.status}`);

  if (!response.ok) {
    if (response.status === 402) {
      console.log("VERDICT: unknown — the account has no credit to reserve against.");
      console.log("This says nothing about tool support. Add credit and re-run.");
    } else {
      console.log("VERDICT: the request failed — this model may not support tools.");
    }
    console.log(body.slice(0, 400));

    return;
  }

  let parsed: {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };

  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    console.log("VERDICT: the response was not JSON.");
    console.log(body.slice(0, 400));

    return;
  }

  const message = parsed.choices?.[0]?.message;
  const calls = message?.tool_calls ?? [];

  console.log(`TEXT   : ${(message?.content ?? "(none)").trim().slice(0, 160)}`);

  if (calls.length === 0) {
    console.log(
      "VERDICT: no tool call. The model ignored the tools array.",
    );

    return;
  }

  for (const call of calls) {
    console.log(
      `TOOL   : ${call.function?.name} ${call.function?.arguments ?? ""}`,
    );
  }

  console.log("VERDICT: the model emitted a tool call.");
}

async function main(): Promise<void> {
  const models = process.argv.slice(2);

  const targets =
    models.length > 0
      ? models
      : [
          process.env.OPENROUTER_MODEL?.trim() ||
            "deepseek/deepseek-v4.1-flash-1017",
        ];

  for (const model of targets) {
    await probe(model);
  }
}

main().catch((error: unknown) => {
  console.error("The probe failed:", error);
  process.exitCode = 1;
});
