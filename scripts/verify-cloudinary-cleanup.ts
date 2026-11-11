import { config } from "dotenv";

import { getStorageDriver } from "@/lib/storage";

config();

/**
 * Checks that the probe left nothing behind in the Cloudinary account.
 *
 * The upload probe deletes each object it creates. This asserts the
 * deletion actually took effect — the object is gone, and a second
 * deletion of the same key is still a success (the idempotency the
 * cleanup job depends on).
 */

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

async function main(): Promise<void> {
  const driver = getStorageDriver();

  const stored = await driver.put({
    bytes: PNG_1X1,
    mimeType: "image/png",
    originalName: "cleanup-probe.png",
    scope: "products",
  });

  console.log(`key          → ${stored.key}`);

  const existedBefore = await driver.exists(stored.key);
  console.log(`exists before → ${existedBefore}`);

  await driver.delete(stored.key);

  const existsAfter = await driver.exists(stored.key);
  console.log(`exists after  → ${existsAfter}`);

  // The cleanup job calls delete() repeatedly on keys it has already
  // tried to remove, so a second delete must not throw.
  await driver.delete(stored.key);
  console.log("second delete → resolved (idempotent)");

  const url = driver.getUrl(stored.key);
  const response = await fetch(url, { method: "GET" });
  console.log(`url status    → ${response.status}`);

  const ok = existedBefore && !existsAfter && response.status === 404;

  console.log("");

  if (!ok) {
    console.error("The cleanup did not take effect.");
    process.exit(1);
  }

  console.log("Delete works, and it is idempotent.");
}

main();
