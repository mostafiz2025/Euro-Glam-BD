/**
 * Step 14 verification script — product image uploads.
 *
 * Proves the product-image upload path behaves correctly against a real
 * database and a real disk, outside the unit tests:
 *
 *   1. **The upload** — files are stored under the `products` scope with
 *      a **generated** key, the bytes on disk are the bytes that were
 *      sent, and a renamed payload is refused.
 *   2. **The all-or-nothing batch** — a batch where one file is
 *      invalid writes **nothing at all**, and the upload root is left
 *      empty afterwards.
 *   3. **The key-not-URL contract** — what lands in `Product.images` is
 *      a storage key, and `imageUrl()` turns it into the public URL.
 *   4. **The audit trail** — an image change is a `PRODUCT_UPDATED`
 *      entry carrying `before.images` and `after.images`, and only the
 *      fields that actually changed appear in the diff.
 *   5. **The legacy path normalisation** — a row holding an absolute
 *      filesystem path is rewritten to the key it points at, so saving
 *      a seeded product repairs it.
 *
 * Run with:  DATABASE_URL=postgresql://... npx tsx scripts/verify-step14.ts
 *
 * The script is safe to run repeatedly: everything it creates is removed
 * again at the end.
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { AdminAction, PrismaClient } from "@prisma/client";

import {
  MAX_PRODUCT_IMAGES,
  uploadProductImages,
} from "@/lib/admin/product-images";
import { updateProduct } from "@/lib/admin/catalog";
import { type AuditActor } from "@/lib/admin/audit";
import { firstImageUrl, imageUrl } from "@/lib/format/image";
import { productCreateSchema, productUpdateSchema } from "@/lib/validation/admin";
import { getLocalStorageDriver } from "@/lib/storage/local-driver";

const prisma = new PrismaClient();

let failures = 0;

/**
 * Prints a check result.
 */
function check(label: string, passed: boolean, detail = ""): void {
  if (passed) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Section heading.
 */
function section(title: string): void {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
}

/**
 * Lists every file under a root, relative to it.
 *
 * Used to assert that a failed batch wrote **nothing** — asserting on a
 * guessed key would also pass if the file had been written under a
 * different name.
 */
async function listStoredFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else {
        // The relative path is normalised to forward slashes, so the
        // assertions work the same on Windows and on Linux.
        found.push(full.slice(root.length + 1).split(sep).join("/"));
      }
    }
  }

  await walk(root);

  return found.sort();
}

/**
 * A tiny but genuinely valid PNG.
 *
 * The bytes are a real 1×1 PNG, so `assertValidImage` sees the PNG
 * signature and the IHDR chunk rather than an empty file.
 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Builds a `File` from bytes, with a chosen name and declared type.
 *
 * The declared type is deliberately settable so a test can present a
 * PNG as `text/plain` and assert that the **bytes** win.
 */
function makeFile(
  name: string,
  bytes: Buffer,
  type: string,
): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const runId = `s14${Date.now()}${Math.floor(Math.random() * 100000)}`;

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const uploadRoots: string[] = [];

let actor: AuditActor;

async function main(): Promise<void> {
  // ── The fixtures ───────────────────────────────────────────────────────
  const user = await prisma.user.create({
    data: {
      name: "Step 14 Verifier",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Step 14 Verifier",
    email: `${runId}_admin@example.com`,
  };

  const category = await prisma.category.findFirst({
    select: { id: true },
  });

  if (!category) {
    throw new Error("No category exists. Seed the database first.");
  }

  // A temporary upload root, so the verification never touches the real
  // `public/uploads` directory.
  const uploadRoot = resolve(tmpdir(), `egb-verify-step14-${runId}`);
  uploadRoots.push(uploadRoot);

  process.env.UPLOAD_ROOT = uploadRoot;

  const adapter = getLocalStorageDriver();

  // ── 1. The upload ─────────────────────────────────────────────────────
  section("1. The upload — a generated key, the bytes on disk");

  const uploaded = await uploadProductImages(
    [
      makeFile("Bioderma atoderm (1).png", PNG_BYTES, "image/png"),
      makeFile("serum & cream.png", PNG_BYTES, "image/png"),
    ],
    adapter,
  );

  check("both files were uploaded", uploaded.length === 2, `${uploaded.length}`);
  check(
    "the key is a storage key, not a URL",
    uploaded.every(
      (image) =>
        image.key.startsWith("products/") &&
        !image.key.includes("://") &&
        !image.key.includes(" "),
    ),
    uploaded[0]?.key ?? "",
  );
  check(
    "the key's extension comes from the detected type",
    uploaded.every((image) => image.key.endsWith(".png")),
  );
  check(
    "the hostile filename is not in the key",
    uploaded.every(
      (image) =>
        !image.key.includes("Bioderma") &&
        !image.key.includes("serum") &&
        !image.key.includes("&"),
    ),
  );
  check(
    "the public URL is derived from the key",
    uploaded.every(
      (image) => image.url === `/uploads/${image.key}`,
    ),
    uploaded[0]?.url ?? "",
  );
  check(
    "the two keys are different",
    uploaded[0]?.key !== uploaded[1]?.key,
  );

  const storedFiles = await listStoredFiles(uploadRoot);

  check(
    "the files are on disk under the products scope",
    storedFiles.length === 2 &&
      storedFiles.every((file) => file.startsWith("products/")),
    storedFiles.join(", "),
  );

  const firstOnDisk = resolve(uploadRoot, storedFiles[0] ?? "");
  const bytesOnDisk = await readFile(firstOnDisk);

  check(
    "the bytes on disk are the bytes that were sent",
    bytesOnDisk.equals(PNG_BYTES),
  );
  check(
    "the stored file is inside the upload root",
    firstOnDisk.startsWith(uploadRoot + sep),
  );

  // ── 2. A renamed payload ──────────────────────────────────────────────
  section("2. A renamed payload is refused");

  let renamedError: { status: number; message: string } | null = null;

  try {
    await uploadProductImages(
      [makeFile("not-really.png", Buffer.from("this is plain text"), "image/png")],
      adapter,
    );
  } catch (error) {
    renamedError = error as { status: number; message: string };
  }

  check("the renamed payload was refused", renamedError !== null);
  check(
    "the refusal is 415 (unsupported media type)",
    renamedError?.status === 415,
    `status ${renamedError?.status ?? "none"}`,
  );
  check(
    "the message names the detected type",
    (renamedError?.message ?? "").includes("PNG") ||
      (renamedError?.message ?? "").toLowerCase().includes("image"),
    renamedError?.message ?? "",
  );

  // ── 3. The all-or-nothing batch ───────────────────────────────────────
  section("3. The all-or-nothing batch");

  const beforeBatch = await listStoredFiles(uploadRoot);

  let batchError: unknown = null;

  try {
    await uploadProductImages(
      [
        makeFile("good-1.png", PNG_BYTES, "image/png"),
        makeFile("good-2.png", PNG_BYTES, "image/png"),
        makeFile("bad.txt", Buffer.from("plain text"), "text/plain"),
      ],
      adapter,
    );
  } catch (error) {
    batchError = error;
  }

  const afterBatch = await listStoredFiles(uploadRoot);

  check("the batch was refused", batchError !== null);
  check(
    "the batch wrote nothing at all",
    afterBatch.length === beforeBatch.length,
    `${beforeBatch.length} before, ${afterBatch.length} after`,
  );

  // ── 4. The batch cap ──────────────────────────────────────────────────
  section("4. The batch cap");

  let capError: unknown = null;

  try {
    await uploadProductImages(
      Array.from({ length: MAX_PRODUCT_IMAGES + 1 }, (_, index) =>
        makeFile(`over-${index}.png`, PNG_BYTES, "image/png"),
      ),
      adapter,
    );
  } catch (error) {
    capError = error;
  }

  check(
    `a batch of ${MAX_PRODUCT_IMAGES + 1} files is refused`,
    capError !== null,
  );
  check(
    "the refused batch wrote nothing",
    (await listStoredFiles(uploadRoot)).length === beforeBatch.length,
  );

  // ── 5. The key-not-URL contract ───────────────────────────────────────
  section("5. The key-not-URL contract");

  const product = await prisma.product.create({
    data: {
      name: `Step 14 Product ${runId}`,
      description: "A product created by the Step 14 verification script.",
      categoryId: category.id,
      pricePaisa: 95000,
      stockQuantity: 5,
      images: uploaded.map((image) => image.key),
    },
    select: { id: true, images: true },
  });

  createdProductIds.push(product.id);

  check(
    "the row stores keys, not URLs",
    product.images.every(
      (image) => !image.includes("://") && image.startsWith("products/"),
    ),
    product.images.join(", "),
  );
  check(
    "imageUrl() derives the public URL from the key",
    imageUrl(product.images[0] ?? "") === `/uploads/${product.images[0] ?? ""}`,
    imageUrl(product.images[0] ?? ""),
  );
  check(
    "firstImageUrl() finds the first image",
    firstImageUrl(product.images) === `/uploads/${product.images[0] ?? ""}`,
  );

  // ── 6. The audit trail ────────────────────────────────────────────────
  section("6. The audit trail — an image change is audited");

  const replacement = await uploadProductImages(
    [makeFile("replacement.png", PNG_BYTES, "image/png")],
    adapter,
  );

  await updateProduct(actor, product.id, {
    images: replacement.map((image) => image.key),
    reason: "Replaced the catalogue photographs.",
  });

  const auditEntries = await prisma.adminAuditLog.findMany({
    where: { entityType: "product", entityId: product.id },
    orderBy: { createdAt: "desc" },
  });

  const updateEntry = auditEntries.find(
    (entry) => entry.action === AdminAction.PRODUCT_UPDATED,
  );

  check("a PRODUCT_UPDATED entry was written", updateEntry !== undefined);
  check(
    "the entry carries the reason",
    (updateEntry?.reason ?? "").includes("Replaced the catalogue"),
    updateEntry?.reason ?? "",
  );

  const before = updateEntry?.before as Record<string, unknown> | undefined;
  const after = updateEntry?.after as Record<string, unknown> | undefined;

  check(
    "before.images holds the old list",
    Array.isArray(before?.images) &&
      (before?.images as string[]).length === uploaded.length,
  );
  check(
    "after.images holds the new list",
    Array.isArray(after?.images) &&
      (after?.images as string[]).length === replacement.length,
  );
  check(
    "only the changed fields appear in the diff",
    before !== undefined &&
      after !== undefined &&
      Object.keys(before).length === 1 &&
      Object.keys(after).length === 1 &&
      "images" in before &&
      "images" in after,
    `before: ${Object.keys(before ?? {}).join(", ")} / after: ${Object.keys(after ?? {}).join(", ")}`,
  );

  // ── 7. The schema accepts a key, refuses a traversal ─────────────────
  section("7. The schema — keys accepted, traversal refused");

  const parsed = productCreateSchema.parse({
    name: "Schema probe",
    categoryId: category.id,
    pricePaisa: 1000,
    images: uploaded.map((image) => image.key),
  });

  check(
    "the schema accepts storage keys",
    parsed.images.length === uploaded.length,
  );

  let traversalError: unknown = null;

  try {
    productCreateSchema.parse({
      name: "Traversal probe",
      categoryId: category.id,
      pricePaisa: 1000,
      images: ["products/../../etc/passwd.png"],
    });
  } catch (error) {
    traversalError = error;
  }

  check("a path-traversal key is refused", traversalError !== null);

  let foreignPathError: unknown = null;

  try {
    productCreateSchema.parse({
      name: "Foreign path probe",
      categoryId: category.id,
      pricePaisa: 1000,
      images: ["C:\\Windows\\System32\\config.png"],
    });
  } catch (error) {
    foreignPathError = error;
  }

  check(
    "an absolute path outside the uploads root is refused",
    foreignPathError !== null,
  );

  const normalised = productUpdateSchema.parse({
    images: [
      "C:\\Users\\someone\\Euro Glam BD\\public\\uploads\\products\\serum.jpg",
    ],
  });

  check(
    "a legacy absolute path is normalised to its key",
    normalised.images?.[0] === "products/serum.jpg",
    normalised.images?.[0] ?? "",
  );

  // ── 8. The product row still renders ──────────────────────────────────
  section("8. The product row still renders");

  const reloaded = await prisma.product.findUnique({
    where: { id: product.id },
    select: { images: true, archivedAt: true },
  });

  check(
    "the product is live, not archived",
    reloaded?.archivedAt === null,
  );
  check(
    "the product points at the replacement image",
    reloaded?.images[0] === replacement[0]?.key,
    reloaded?.images[0] ?? "",
  );
}

async function cleanup(): Promise<void> {
  for (const productId of createdProductIds) {
    await prisma.product.deleteMany({ where: { id: productId } });
  }

  for (const userId of createdUserIds) {
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  for (const root of uploadRoots) {
    await rm(root, { recursive: true, force: true });
  }

  await prisma.$disconnect();
}

main()
  .catch((error: unknown) => {
    console.error("\nThe verification script itself failed:");
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();

    console.log("\nSummary\n───────");

    if (failures === 0) {
      console.log("  All Step 14 checks passed.");
      process.exit(0);
    }

    console.error(`  ${failures} Step 14 check(s) failed.`);
    process.exit(1);
  });
