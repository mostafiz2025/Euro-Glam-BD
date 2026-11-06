import { PrismaClient } from "@prisma/client";

/**
 * The integration suite's Prisma client.
 *
 * ── Why the suite shares one client ──────────────────────────────────────
 *
 * Every integration file needs a database connection, and every file
 * opening its **own** client opens its own **pool** — Prisma's default
 * is ten connections per client. Twenty-four files, each with a pool of
 * ten, is two hundred and forty connections' worth of appetite against
 * a PostgreSQL server whose default `max_connections` is a hundred.
 *
 * The suite already runs its files one at a time (see
 * `vitest.config.ts`), so the files never need a connection *at the same
 * time* — they need one client that hands its connection back between
 * them. One shared client with a small pool is the right shape.
 *
 * ── Why the pool is small ─────────────────────────────────────────────────
 *
 * The pool is capped at two. The suite is deliberately serial, so two
 * connections is enough for any single test: one for the test's own
 * query and one for a transaction the test has open while it asserts on
 * the same row from outside.
 *
 * The budget left over matters more than the throughput: the development
 * server, the seed script and the suite all share one server-wide
 * `max_connections`, and a suite that takes a hundred of them makes the
 * application untestable while it runs.
 *
 * The client is **not** disconnected after each file. Vitest's
 * `singleFork` runs every integration file in one process, so the pool
 * is opened once and reused — which is the point.
 */
export const prisma = new PrismaClient({
  datasourceUrl: (() => {
    const url = process.env.DATABASE_URL;

    if (url === undefined) return undefined;

    if (/[?&]connection_limit=/.test(url)) return url;

    const separator = url.includes("?") ? "&" : "?";

    return `${url}${separator}connection_limit=2`;
  })(),
});
