import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest configuration.
 *
 * The `@/*` alias must be declared here explicitly — Vitest does not read
 * tsconfig.json paths on its own.
 *
 * ── Why the suite is split into two projects ───────────────────────────────
 *
 * The tests fall into two kinds, and they have **incompatible**
 * requirements:
 *
 *   • **Unit tests** (`tests/unit`, `tests/validation`, `tests/format`,
 *     `tests/admin`, `tests/orders`, `tests/payments`, `tests/sms`,
 *     `tests/ai`, `tests/home`) are pure functions. They touch no shared
 *     state, so running them in parallel is free.
 *
 *   • **Integration tests** (`tests/integration`) talk to a **real
 *     PostgreSQL database** — the same one, shared by every file.
 *
 * The integration suites create rows and delete them again in
 * `afterAll`. When two of those files run at the same time, one file's
 * cleanup can delete a row another file is still asserting on, and a
 * whole-table count taken by one file can disagree with the same count
 * taken by another. Those failures are not flaky *tests* — they are
 * correct tests losing a race with a moving table.
 *
 * So the integration project runs its files **one at a time**. The
 * unit project keeps running in parallel. The trade is wall-clock
 * time for the integration half; the benefit is that an integration
 * failure now means the service is wrong, rather than that two files
 * happened to overlap.
 *
 * This is the same reasoning behind Prisma's own advice for a shared
 * development database: serialise the suites, or give each one its
 * own database. One database means one queue.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "tests/validation/**/*.test.ts",
            "tests/format/**/*.test.ts",
            "tests/admin/**/*.test.ts",
            "tests/orders/**/*.test.ts",
            "tests/payments/**/*.test.ts",
            "tests/sms/**/*.test.ts",
            "tests/ai/**/*.test.ts",
            "tests/api/**/*.test.ts",
            "tests/auth/**/*.test.ts",
            "tests/commerce/**/*.test.ts",
            "tests/conflicts/**/*.test.ts",
            "tests/pricing/**/*.test.ts",
            "tests/storage/**/*.test.ts",
            "tests/upload/**/*.test.ts",
            "tests/home/**/*.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // One file at a time — they share a single PostgreSQL.
          //
          // `poolOptions.forks.singleFork` is the lever. Vitest 3
          // treats `fileParallelism` and `maxWorkers` as root-level
          // options that cannot be set per project, but a project may
          // ask for a *single fork*, which runs its files one after
          // another in one process.
          //
          // (The fork pool is also what the default `threads` pool
          // cannot do here: a worker thread shares the process, and
          // Prisma's connection handling is happier in a dedicated
          // child process.)
          poolOptions: {
            forks: { singleFork: true },
          },
          // A generous timeout: the first file to touch a cold database
          // pays for the connection setup and the schema's first
          // query plan, and the transactional tests deliberately wait
          // on real locks.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
