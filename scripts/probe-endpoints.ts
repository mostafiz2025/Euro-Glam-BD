import "dotenv/config";

/**
 * A diagnostic: how many upstream providers can serve this model, and do
 * they support **tools**?
 *
 * ── Why this matters ─────────────────────────────────────────────────────
 *
 * The advisor needs the product ids back from the model. There are two
 * channels for that: the `[RECOMMENDED: …]` marker line, and a
 * structured tool call.
 *
 * A tool call is the reliable channel — but adding `tools` to the
 * request can *narrow the pool of upstream providers* able to serve it,
 * and a narrower pool is a smaller set of providers to fall back to
 * when one of them is rate-limited.
 *
 * That is a direct trade against the whole reason for using a router, so
 * the size of the pool is worth knowing before the request shape is
 * changed.
 *
 * Run it with:
 *
 *   npx tsx scripts/probe-endpoints.ts [model]
 */

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();

  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set.");
    process.exitCode = 1;
    return;
  }

  const model =
    process.argv[2]?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    "deepseek/deepseek-v4.1-flash-1017";

  const response = await fetch(
    `https://openrouter.ai/api/v1/models/${model}/endpoints`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.NEXT_PUBLIC_SITE_URL?.trim()
          ? { "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL.trim() }
          : {}),
        "X-Title": process.env.OPENROUTER_TITLE?.trim() ?? "Euro Glam BD",
      },
    },
  );

  const text = await response.text();

  console.log(`=== ${model}`);
  console.log(`HTTP ${response.status}`);

  if (!response.ok) {
    console.log(text.slice(0, 600));
    return;
  }

  const parsed = JSON.parse(text) as {
    data?: {
      endpoints?: Array<{
        provider_name?: string;
        supported_parameters?: string[];
        quantization?: string | null;
        max_completion_tokens?: number | null;
      }>;
    };
  };

  const endpoints = parsed.data?.endpoints ?? [];

  console.log(`ENDPOINTS : ${endpoints.length}`);

  let withTools = 0;

  for (const endpoint of endpoints) {
    const parameters = endpoint.supported_parameters ?? [];

    const hasTools =
      parameters.includes("tools") || parameters.includes("tool_choice");

    if (hasTools) withTools += 1;

    console.log(
      `  ${(endpoint.provider_name ?? "?").padEnd(28)} tools ${hasTools ? "✓" : "✗"}  quant ${endpoint.quantization ?? "-"}  max ${endpoint.max_completion_tokens ?? "-"}`,
    );
  }

  console.log(
    `\nSUMMARY: ${withTools}/${endpoints.length} endpoints support tools.`,
  );
}

main().catch((error: unknown) => {
  console.error("The probe failed:", error);
  process.exitCode = 1;
});
