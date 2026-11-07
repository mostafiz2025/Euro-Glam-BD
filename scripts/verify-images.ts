/**
 * Verifies that every image key the database holds resolves to a real
 * asset on the live CDN.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CLOUD = process.env.CLOUDINARY_CLOUD_NAME ?? "yexokeng";
const FOLDER = "euro-glam-bd";

type Row = { id: string; [key: string]: unknown };

const COLUMNS = [
  { table: "Product", column: "images", list: true },
  { table: "Category", column: "image", list: false },
  { table: "SkinConcern", column: "image", list: false },
  { table: "Brand", column: "logo", list: false },
  { table: "HeroBanner", column: "image", list: false },
  { table: "AdvisorImage", column: "storageKey", list: false },
];

async function main() {
  const keys = new Set<string>();

  for (const spec of COLUMNS) {
    const model = (prisma as never as Record<
      string,
      { findMany: (a: unknown) => Promise<Row[]> }
    >)[spec.table];

    const rows = await model.findMany({});

    for (const row of rows) {
      const value = row[spec.column];

      if (Array.isArray(value)) {
        for (const k of value) if (typeof k === "string" && k) keys.add(k);
      } else if (typeof value === "string" && value) {
        keys.add(value);
      }
    }
  }

  console.log(`distinct image keys in the database: ${keys.size}\n`);

  let ok = 0;
  const broken: string[] = [];

  for (const key of [...keys].sort()) {
    // The URL the application actually builds.
    const publicId = key.replace(/\.[^./]+$/, "");
    const url = `https://res.cloudinary.com/${CLOUD}/image/upload/${FOLDER}/${publicId}`;

    const res = await fetch(url, { method: "HEAD" });

    if (res.ok) {
      ok += 1;
    } else {
      broken.push(`${key}  (${res.status})  ${url}`);
    }
  }

  console.log(`resolving: ${ok}/${keys.size}`);

  if (broken.length > 0) {
    console.log(`\nBROKEN (${broken.length}):`);
    for (const b of broken) console.log("  " + b);
  }
}

main()
  .catch((e) => console.error("ERR:", (e as Error).message))
  .finally(() => prisma.$disconnect());
