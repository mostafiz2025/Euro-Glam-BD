import { config } from "dotenv";

import { getStorageDriver } from "@/lib/storage";
import { imageUrl } from "@/lib/format/image";

config();

/**
 * An end-to-end check of the Cloudinary upload path.
 *
 * Uploads a real 1×1 PNG into every scope the shop uses, then checks
 * that:
 *
 *   1. The upload succeeds and returns a **key**.
 *   2. The key resolves to a URL that **actually exists** — the object
 *      is fetched back from Cloudinary's CDN.
 *   3. `imageUrl()` and the driver's `getUrl()` agree on that URL.
 *   4. The file can be deleted again, so the check leaves nothing
 *      behind.
 *
 * The fetch in step 2 is the part that matters: a URL that is
 * well-formed but points at nothing is exactly the bug this whole
 * exercise is about.
 */

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

const SCOPES = [
  "products",
  "brands",
  "categories",
  "concerns",
  "hero",
] as const;

async function main(): Promise<void> {
  const driver = getStorageDriver();

  let failures = 0;

  for (const scope of SCOPES) {
    try {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "probe.png",
        scope,
      });

      const viaHelper = imageUrl(stored.key);
      const viaDriver = driver.getUrl(stored.key);

      const agree = viaHelper === viaDriver;

      const response = await fetch(viaHelper, { method: "GET" });
      const reachable = response.ok;

      /*
       * The bytes are NOT compared for equality with the upload.
       *
       * Cloudinary re-encodes the image on delivery, so the bytes that
       * come back are not the bytes that went up — they are the same
       * *picture*, encoded differently. A byte-equality check would fail
       * on a perfectly good upload.
       *
       * What is checked instead is the **magic number**: the delivered
       * bytes must still begin with the PNG signature. That proves the
       * URL resolves to the image that was uploaded rather than to an
       * error page that happens to return 200.
       */
      const bytes = reachable ? Buffer.from(await response.arrayBuffer()) : null;
      const isPng =
        bytes !== null &&
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(PNG_1X1.subarray(0, 8));

      const ok = agree && reachable && isPng;

      if (!ok) failures++;

      console.log(`${ok ? "OK  " : "FAIL"} ${scope}`);
      console.log(`       key        → ${stored.key}`);
      console.log(`       url        → ${viaHelper}`);
      console.log(`       agree      → ${agree}`);
      console.log(`       reachable  → ${response.status} ${reachable}`);
      console.log(`       is a png   → ${isPng}`);

      // Clean up so the probe leaves nothing behind in the account.
      await driver.delete(stored.key);
    } catch (error) {
      failures++;

      console.log(`FAIL ${scope}`);
      console.error(`       ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log("");

  if (failures > 0) {
    console.error(`${failures} scope(s) failed.`);
    process.exit(1);
  }

  console.log("All scopes uploaded, resolved and cleaned up.");
}

main();
