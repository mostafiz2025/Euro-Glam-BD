/**
 * Backfills image assets from the local filesystem to Cloudinary.
 *
 * ── Why this script exists ────────────────────────────────────────────────
 *
 * The catalogue's image rows were written while the **local** driver was
 * configured, so they hold local-disk keys:
 *
 *   • `products/Bioderma Sensibio.jpg`            — hand-placed files
 *   • `categories/2026/10/a9dd8587….jpg`          — uploaded locally
 *
 * The driver was then switched to Cloudinary. `imageUrl()` now builds a
 * Cloudinary URL for every key — correctly — but **the assets were never
 * uploaded there**, so every one of those URLs resolves to a 404 and the
 * admin panel shows broken previews.
 *
 * The URL was never wrong. The *bytes* were on the wrong side of the
 * migration.
 *
 * ── What this script does ────────────────────────────────────────────────
 *
 * For every image referenced by the database:
 *
 *   1. If the key already resolves on Cloudinary, leave it alone.
 *   2. Otherwise, read the file from `public/uploads/<key>`, upload it
 *      through the storage adapter, and rewrite the row to the new key.
 *
 * The new key keeps the original filename, so the migration is
 * **recognisable** in the admin panel and **idempotent** — a second run
 * finds the asset already on Cloudinary and skips it.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 *   • **Dry run by default.** Nothing is written until `--apply` is passed.
 *   • **Never deletes.** The local files stay where they are; the database
 *     is the only thing that changes, and it can be pointed back.
 *   • **Per-row transactions.** A failure on one row does not roll back
 *     the rows that already succeeded.
 *
 * Usage:
 *   npx tsx scripts/backfill-images-to-cloudinary.ts            # dry run
 *   npx tsx scripts/backfill-images-to-cloudinary.ts --apply    # write
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { detectMimeType } from "../src/lib/upload/validate";

const prisma = new PrismaClient();

/**
 * The local upload root, relative to the project root.
 */
const LOCAL_ROOT = path.resolve(process.cwd(), "public", "uploads");

/**
 * The Cloudinary driver's folder. Mirrors `CLOUDINARY_FOLDER` in the
 * driver — the public id of every uploaded asset begins with it.
 */
const CLOUDINARY_FOLDER = "euro-glam-bd";

/**
 * The dry-run flag.
 */
const APPLY = process.argv.includes("--apply");

/**
 * The image-bearing rows, gathered across every table that stores one.
 *
 * Each entry names the table, the column, and how to read the key out of
 * a row. The three shapes are:
 *
 *   • a **list** of keys — `Product.images`
 *   • a **single nullable** key — `Category.image`
 *   • a **single nullable** key — `Brand.logo`
 */
type ImageColumn = {
  readonly table: string;
  readonly column: string;
  readonly list: boolean;
};

const IMAGE_COLUMNS: readonly ImageColumn[] = [
  { table: "Product", column: "images", list: true },
  { table: "Category", column: "image", list: false },
  { table: "SkinConcern", column: "image", list: false },
  { table: "Brand", column: "logo", list: false },
  { table: "HeroBanner", column: "image", list: false },
  { table: "AdvisorImage", column: "storageKey", list: false },
  { table: "Review", column: "imageUrl", list: false },
];

type Row = {
  id: string;
  [key: string]: unknown;
};

/**
 * A key that needs migrating, and where it came from.
 */
type Pending = {
  readonly table: string;
  readonly column: string;
  readonly id: string;
  readonly key: string;
  readonly scope: string;
};

/**
 * The scope a key belongs to — the first path segment.
 *
 * The driver writes `<scope>/<yyyy>/<mm>/<random>.<ext>`, and the scope
 * is the allow-listed namespace. The legacy hand-placed files sit
 * directly in the scope's directory (`products/Bioderma Sensibio.jpg`),
 * so their first segment is still the scope.
 */
function scopeFor(key: string): string {
  return key.split("/")[0] ?? "products";
}

/**
 * The characters Cloudinary refuses in a public id.
 *
 * Established by uploading to the live account, not read off a
 * documentation page: `%`, `&` and `#` are rejected outright with
 * `public_id (…) is invalid`. Everything else the catalogue actually
 * contains — spaces, em-dashes, `+`, parentheses, commas, accented
 * letters — is accepted unchanged.
 *
 * So only these three are substituted, and each is replaced by a
 * character that cannot collide with the others.
 */
const REJECTED_IN_PUBLIC_ID = /[%&#]/g;

/**
 * The character each rejected one is replaced with.
 *
 * `_` rather than a dash, because a dash is common in the product
 * names already in the catalogue and using it would make two different
 * filenames map to the same key.
 */
const PUBLIC_ID_SUBSTITUTION = "_";

/**
 * The key a file is uploaded under, sanitised for Cloudinary.
 *
 * The extension is stripped, because Cloudinary appends the format to
 * the public id itself — a public id that already ends in `.jpg` is
 * stored as `….jpg.jpg`.
 */
function sanitisePublicId(key: string): string {
  return key
    .replace(/\.[^./]+$/, "")
    .replace(REJECTED_IN_PUBLIC_ID, PUBLIC_ID_SUBSTITUTION);
}

/**
 * The key a sanitised public id maps back to.
 *
 * The inverse of `sanitisePublicId`, used to write the row: the row
 * holds the **storage key**, which is the public id with the format
 * back on.
 */
function keyFromPublicId(publicId: string, originalKey: string): string {
  const extension = originalKey.match(/\.([^./]+)$/)?.[1] ?? "jpg";

  return `${publicId}.${extension}`;
}

/**
 * The path of a key on the local disk.
 */
function localPathFor(key: string): string {
  const resolved = path.resolve(LOCAL_ROOT, key);

  /*
   * A key that escapes the upload root is not ours to read. The
   * traversal check mirrors the local driver's own: a key like
   * `../../etc/passwd` must not send the script outside the root.
   */
  if (resolved !== LOCAL_ROOT && !resolved.startsWith(LOCAL_ROOT + path.sep)) {
    throw new Error(`The key "${key}" escapes the upload root.`);
  }

  return resolved;
}

/**
 * Whether a key already names an asset on Cloudinary.
 *
 * The check is on the **public id**, because that is what Cloudinary
 * stores: the key without its extension, under our folder. A key whose
 * public id is absent is a key that still needs migrating.
 */
async function existsOnCloudinary(key: string): Promise<boolean> {
  const publicId = `${CLOUDINARY_FOLDER}/${sanitisePublicId(key)}`;

  try {
    const { v2: cloudinary } = await import("cloudinary");

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });

    await cloudinary.api.resource(publicId, {
      resource_type: "image",
      type: "upload",
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Gathers every image key the database holds.
 */
async function collectPending(): Promise<Pending[]> {
  const pending: Pending[] = [];

  for (const spec of IMAGE_COLUMNS) {
    const rows = (await (prisma as never as Record<string, { findMany: (a: unknown) => Promise<Row[]> }>)[
      spec.table
    ].findMany({})) as Row[];

    for (const row of rows) {
      if (spec.list) {
        const keys = row[spec.column];

        if (!Array.isArray(keys)) continue;

        for (const key of keys) {
          if (typeof key === "string" && key.trim() !== "") {
            pending.push({
              table: spec.table,
              column: spec.column,
              id: row.id,
              key,
              scope: scopeFor(key),
            });
          }
        }
      } else {
        const key = row[spec.column];

        if (typeof key === "string" && key.trim() !== "") {
          pending.push({
            table: spec.table,
            column: spec.column,
            id: row.id,
            key,
            scope: scopeFor(key),
          });
        }
      }
    }
  }

  return pending;
}

/**
 * Uploads one local file to Cloudinary under a **stable** key.
 *
 * The key keeps the original filename, so the migrated asset is
 * recognisable and the migration is idempotent. The driver normally
 * generates a random name; here the name is the point.
 */
async function uploadWithStableKey(
  key: string,
): Promise<string> {
  const absolute = localPathFor(key);
  const bytes = await readFile(absolute);
  const mimeType = detectMimeType(bytes);

  if (!mimeType) {
    throw new Error(`The file for "${key}" is not a recognised image.`);
  }

  /*
   * The asset is uploaded under a **stable, recognisable** public id —
   * the original path with the extension off, and the three characters
   * Cloudinary refuses substituted.
   *
   *   products/Bioderma Sensibio.jpg  →  products/Bioderma Sensibio
   *   products/The Ordinary 12%.jpg   →  products/The Ordinary 12_
   *
   * The driver normally generates a random name; here the name is the
   * point, because it makes the migration recognisable in the admin
   * panel and idempotent — a second run finds the asset already there.
   */
  const { v2: cloudinary } = await import("cloudinary");

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });

  const publicId = sanitisePublicId(key);

  await new Promise<void>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: CLOUDINARY_FOLDER,
        public_id: publicId,
        resource_type: "image",
        overwrite: true,
      },
      (error: unknown) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      },
    );

    stream.end(bytes);
  });

  return keyFromPublicId(publicId, key);
}

/**
 * Rewrites the row to point at the migrated key.
 *
 * The key is unchanged when the file kept its own name, so this is a
 * no-op for the legacy hand-placed files — but the **existence check**
 * is what moves them from "404" to "renders". The rewrite exists for the
 * case where a key had to change.
 */
async function rewriteRow(
  spec: { table: string; column: string },
  rowId: string,
  oldKey: string,
  newKey: string,
): Promise<void> {
  if (oldKey === newKey) {
    // The key is unchanged; there is nothing to write.
    return;
  }

  const model = (prisma as never as Record<
    string,
    {
      findUnique: (a: unknown) => Promise<Row | null>;
      update: (a: unknown) => Promise<unknown>;
    }
  >)[spec.table];

  const row = await model.findUnique({ where: { id: rowId } });

  if (!row) {
    throw new Error(`The row ${spec.table}/${rowId} no longer exists.`);
  }

  const current = row[spec.column];

  if (Array.isArray(current)) {
    await model.update({
      where: { id: rowId },
      data: {
        [spec.column]: current.map((k) => (k === oldKey ? newKey : k)),
      },
    });
  } else {
    await model.update({
      where: { id: rowId },
      data: { [spec.column]: newKey },
    });
  }
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`Driver: ${process.env.STORAGE_DRIVER ?? "local"}`);
  console.log("");

  const pending = await collectPending();

  // Deduplicate: the same key can be referenced by several rows.
  const byKey = new Map<string, Pending[]>();

  for (const item of pending) {
    const list = byKey.get(item.key) ?? [];
    list.push(item);
    byKey.set(item.key, list);
  }

  console.log(
    `Rows referencing images: ${pending.length}; distinct keys: ${byKey.size}`,
  );
  console.log("");

  let uploaded = 0;
  let alreadyThere = 0;
  let missing = 0;
  let failed = 0;

  for (const [key, references] of byKey) {
    if (await existsOnCloudinary(key)) {
      alreadyThere += 1;
      console.log(`  ok       ${key} (already on Cloudinary)`);
      continue;
    }

    let bytes: Buffer;

    try {
      bytes = await readFile(localPathFor(key));
    } catch {
      missing += 1;
      console.log(
        `  MISSING  ${key} — not on disk and not on Cloudinary (${references.length} row(s))`,
      );
      continue;
    }

    if (!APPLY) {
      console.log(
        `  would    ${key} — ${bytes.length}B (${references.length} row(s))`,
      );
      uploaded += 1;
      continue;
    }

    try {
      const newKey = await uploadWithStableKey(key);

      for (const reference of references) {
        await rewriteRow(
          { table: reference.table, column: reference.column },
          reference.id,
          key,
          newKey,
        );
      }

      uploaded += 1;
      console.log(
        `  uploaded ${key}${newKey === key ? "" : ` → ${newKey}`} — ${bytes.length}B`,
      );
    } catch (error) {
      failed += 1;
      console.error(`  FAILED   ${key}:`, (error as Error).message);
    }
  }

  console.log("");
  console.log(
    `Summary: ${uploaded} uploaded, ${alreadyThere} already present, ${missing} missing, ${failed} failed`,
  );

  if (!APPLY) {
    console.log("");
    console.log("This was a dry run. Re-run with --apply to write.");
  }
}

main()
  .catch((error) => {
    console.error("ERR:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
