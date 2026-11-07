/**
 * Confirms the CDN returns real image bytes for every stored key.
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

    for (const row of await model.findMany({})) {
      const value = row[spec.column];

      if (Array.isArray(value)) {
        for (const k of value) if (typeof k === "string" && k) keys.add(k);
      } else if (typeof value === "string" && value) {
        keys.add(value);
      }
    }
  }

  let good = 0;
  const bad: string[] = [];

  for (const key of [...keys].sort()) {
    const publicId = key.replace(/\.[^./]+$/, "");
    const url = `https://res.cloudinary.com/${CLOUD}/image/upload/${FOLDER}/${publicId}`;

    const res = await fetch(url);

    if (!res.ok) {
      bad.push(`${key} :: HTTP ${res.status}`);
      continue;
    }

    const type = res.headers.get("content-type") ?? "";
    const bytes = Buffer.from(await res.arrayBuffer());

    // A real image starts with a JPEG / PNG / WebP magic number.
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng =
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e;
    const isWebp =
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";

    if (type.startsWith("image/") && (isJpeg || isPng || isWebp)) {
      good += 1;
    } else {
      bad.push(`${key} :: ${type} ${bytes.length}B (not an image)`);
    }
  }

  console.log(`real images: ${good}/${keys.size}`);

  if (bad.length > 0) {
    console.log(`\nNOT IMAGES (${bad.length}):`);
    for (const b of bad) console.log("  " + b);
  }
}

main()
  .catch((e) => console.error("ERR:", (e as Error).message))
  .finally(() => prisma.$disconnect());
