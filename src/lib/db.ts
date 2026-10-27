import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton.
 *
 * Next.js hot-reloads modules in development. Without the global cache, each
 * reload creates a new PrismaClient, each with its own connection pool
 * (default max 10 per instance). That exhausts PostgreSQL's connection limit
 * and produces "too many clients already" errors that are painful to diagnose.
 *
 * The global pattern is safe here because in development the client holds no
 * state that must survive a reload.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
