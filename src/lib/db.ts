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
 *
 * ── Why the pool is capped ────────────────────────────────────────────────
 *
 * PostgreSQL's default `max_connections` is 100, and it is a **server-wide**
 * budget shared by everything that talks to the database: this application,
 * the test suite, a psql session, and every other tool on the machine. The
 * default Prisma pool is ten connections per client instance, which is a
 * reasonable number for one client — but it is not a number that assumes it
 * is the only one.
 *
 * So the pool is capped at five, and the cap is deliberately smaller than
 * the default. A client holding ten connections can, on its own, take a
 * tenth of the server's budget; three clients — the dev server, the test
 * runner, a script — then exhaust it between them.
 *
 * Five is enough for this application: the storefront reads a page's worth
 * of products in parallel, and the heaviest query — the dashboard's
 * fourteen counts — settles well inside it. A request that needs more waits
 * for a free connection, which is the correct behaviour: it is slower by
 * milliseconds, and it cannot take the database down.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * The pool size.
 *
 * Overridable through the environment for the rare case that a deployment
 * has a database sized for more — but the default is the conservative one.
 */
const CONNECTION_LIMIT = Number.parseInt(
  process.env.DATABASE_POOL_SIZE ?? "5",
  10,
);

/**
 * The connection URL, with the pool cap applied.
 *
 * Prisma reads the pool size from the URL's `connection_limit` parameter,
 * so the cap has to be expressed there rather than in the client options.
 * An existing `connection_limit` in the URL wins — an operator who set it
 * deliberately meant it.
 */
function withPoolLimit(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;

  if (/[?&]connection_limit=/.test(url)) return url;

  const separator = url.includes("?") ? "&" : "?";

  return `${url}${separator}connection_limit=${CONNECTION_LIMIT}`;
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
    datasourceUrl: withPoolLimit(process.env.DATABASE_URL),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
