import { config } from "dotenv";

import { imageUrl } from "@/lib/format/image";
import { getStorageDriver } from "@/lib/storage";

config();

/**
 * A round-trip check between the two places that turn a key into a URL.
 *
 * The upload path writes through `getStorageDriver()` and the render path
 * reads through `imageUrl()`. They are different modules, so they can
 * drift — and a drift between them is invisible until a shopper sees a
 * broken image.
 *
 * So this asserts they agree, for every scope the shop uploads into.
 */
const SCOPES = [
  "products",
  "brands",
  "categories",
  "concerns",
  "hero",
  "reviews",
  "advisor",
  "profiles",
] as const;

const driver = getStorageDriver();

console.log(`STORAGE_DRIVER = ${process.env.STORAGE_DRIVER}`);
console.log(`Cloudinary cloud = ${process.env.CLOUDINARY_CLOUD_NAME}`);
console.log("");

let failures = 0;

for (const scope of SCOPES) {
  const key = `${scope}/2026/11/abc123.png`;

  const viaHelper = imageUrl(key);
  const viaDriver = driver.getUrl(key);

  const agree = viaHelper === viaDriver;

  if (!agree) failures++;

  console.log(`${agree ? "OK  " : "FAIL"} ${scope}`);
  console.log(`       imageUrl()    → ${viaHelper}`);
  console.log(`       driver.getUrl → ${viaDriver}`);
}

console.log("");

if (failures > 0) {
  console.error(`${failures} scope(s) disagree.`);
  process.exit(1);
}

console.log("All scopes agree.");
