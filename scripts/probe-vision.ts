import "dotenv/config";

/**
 * A diagnostic: does an OpenRouter model read images?
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * OpenRouter filters the upstream endpoints by image support
 * **automatically**, and a photo sent to a text-only model comes back
 * as a hard `404`:
 *
 * > No endpoints found that support image input
 *
 * That is not a degraded answer — it is a failed request — and the
 * advisor's photo analysis is a headline feature. So `OPENROUTER_MODEL`
 * must name a **multimodal** model, and the only reliable way to know
 * is to send it a photo and see.
 *
 * This script does exactly that, and it is the complement to
 * `scripts/verify-openrouter.ts`: the verify script checks the
 * *configured* model end to end, and this one checks the *capability* of
 * a candidate model before it is configured.
 *
 * Run it with:
 *
 *   npx tsx scripts/probe-vision.ts
 *   npx tsx scripts/probe-vision.ts some/model-id another/model-id
 *
 * With no arguments it probes the model named by `OPENROUTER_MODEL`.
 *
 * It needs `OPENROUTER_API_KEY` in the environment. It does not write to
 * the database, and it does not touch the storefront.
 */

/**
 * A 1x1 red PNG, inlined so the probe needs no file and no upload.
 */
const RED_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Probes one model and reports what it can do.
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
            content: [
              {
                type: "text",
                text: "What colour is this image? Answer with one word.",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${RED_PIXEL_PNG}` },
              },
            ],
          },
        ],
        provider: { allow_fallbacks: true },
        // State a ceiling, or OpenRouter reserves the model's whole
        // context window against the account credit and refuses with a
        // 402 — which would be misread as "this model cannot see images".
        max_tokens: 1200,
      }),
    },
  );

  const body = await response.text();

  console.log(`\n=== ${model}`);
  console.log(`HTTP ${response.status}`);

  if (!response.ok) {
    /*
     * The two `404`s a model can produce are the interesting case, and
     * they need different fixes:
     *
     *   • "No endpoints found that support image input" — the model is
     *     text-only. Pick a multimodal one.
     *   • anything else — the model id is wrong.
     */
    if (body.includes("support image input")) {
      console.log("VERDICT: text-only. This model cannot read images.");
      console.log("         Choose a multimodal model for OPENROUTER_MODEL.");
    } else if (response.status === 402) {
      console.log("VERDICT: unknown — the account has no credit to reserve against.");
      console.log("         This says nothing about image support. Add credit and re-run.");
    } else {
      console.log("VERDICT: the request failed. The model id is probably wrong.");
    }

    console.log(body.slice(0, 400));

    return;
  }

  const answer =
    (() => {
      try {
        const parsed = JSON.parse(body) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };

        return parsed.choices?.[0]?.message?.content ?? "(no content)";
      } catch {
        return body.slice(0, 200);
      }
    })();

  console.log(`ANSWER: ${answer.trim()}`);
  console.log("VERDICT: the model accepted the image.");
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
