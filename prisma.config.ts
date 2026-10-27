import path from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// The Prisma CLI no longer auto-loads .env when a prisma.config.ts is
// present, so we load it explicitly. Next.js loads .env itself at runtime;
// this is only for CLI commands (migrate, generate, seed).
loadEnv({ path: path.join(process.cwd(), ".env") });

/**
 * Prisma CLI configuration.
 *
 * Replaces the deprecated `package.json#prisma` block. Prisma 7 will remove
 * that property; this file is the forward-compatible location.
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),

  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },

  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
