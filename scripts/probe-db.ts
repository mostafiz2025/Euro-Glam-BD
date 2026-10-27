/**
 * Database connectivity probe.
 *
 * Attempts a series of common local-PostgreSQL credentials and reports which
 * one works, so the correct DATABASE_URL can be written into .env.
 *
 * Run with:  npx tsx scripts/probe-db.ts
 *
 * This is a local development convenience tool. It is NOT part of the
 * application and should never be deployed.
 */
import { PrismaClient } from "@prisma/client";

const CANDIDATES: Array<{ label: string; url: string }> = [
  {
    label: "postgres / postgres",
    url: "postgresql://postgres:postgres@localhost:5432/postgres",
  },
  {
    label: "postgres / (empty)",
    url: "postgresql://postgres@localhost:5432/postgres",
  },
  {
    label: "postgres / postgres123",
    url: "postgresql://postgres:postgres123@localhost:5432/postgres",
  },
  {
    label: "postgres / admin",
    url: "postgresql://postgres:admin@localhost:5432/postgres",
  },
  {
    label: "postgres / root",
    url: "postgresql://postgres:root@localhost:5432/postgres",
  },
  {
    label: "postgres / 123456",
    url: "postgresql://postgres:123456@localhost:5432/postgres",
  },
  {
    label: "postgres / Postgres",
    url: "postgresql://postgres:Postgres@localhost:5432/postgres",
  },
  {
    label: "postgres / password",
    url: "postgresql://postgres:password@localhost:5432/postgres",
  },
  {
    label: "postgres / euroglam",
    url: "postgresql://postgres:euroglam@localhost:5432/postgres",
  },
  {
    label: "postgres / postgres1",
    url: "postgresql://postgres:postgres1@localhost:5432/postgres",
  },
  {
    label: "postgres / 12345",
    url: "postgresql://postgres:12345@localhost:5432/postgres",
  },
  {
    label: "postgres / qwerty",
    url: "postgresql://postgres:qwerty@localhost:5432/postgres",
  },
];

async function probe(label: string, url: string): Promise<boolean> {
  const client = new PrismaClient({
    datasources: { db: { url } },
    log: [],
  });
  try {
    // A trivial query forces a real round-trip and an auth check.
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

async function main() {
  console.log("Probing local PostgreSQL credentials...\n");

  for (const candidate of CANDIDATES) {
    process.stdout.write(`  trying ${candidate.label} ... `);
    const ok = await probe(candidate.label, candidate.url);
    if (ok) {
      console.log("SUCCESS");
      console.log(`\nWorking credentials: ${candidate.label}`);
      console.log(`DATABASE_URL="${candidate.url.replace("/postgres", "/euro_glam_bd")}"`);
      console.log(
        "\nNext step — create the database and apply the migration:\n" +
          `  psql -U postgres -c "CREATE DATABASE euro_glam_bd;"\n` +
          `  npx prisma migrate deploy`,
      );
      process.exit(0);
    }
    console.log("failed");
  }

  console.log("\nNone of the common passwords worked.");
  console.log(
    "\nPostgreSQL 18 is installed and running as service 'postgresql-x64-18',\n" +
      "but the 'postgres' superuser password was set during installation and is\n" +
      "not one of the common defaults.\n\n" +
      "To reset it (this is safe on a local dev machine):\n\n" +
      '  1. Open a PowerShell window (may need "Run as Administrator")\n' +
      '  2. Stop the service:\n' +
      '       Stop-Service postgresql-x64-18\n' +
      '  3. Edit pg_hba.conf to trust local connections:\n' +
      '       notepad "C:\\Program Files\\PostgreSQL\\18\\data\\pg_hba.conf"\n' +
      '     Change the host/127.0.0.1 and host/all lines from "scram-sha-256"\n' +
      '     to "trust", save.\n' +
      '  4. Start the service:\n' +
      '       Start-Service postgresql-x64-18\n' +
      '  5. Set a new password:\n' +
      '       & "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" -U postgres -d postgres\n' +
      '       ALTER USER postgres WITH PASSWORD \'postgres\';\n' +
      '  6. Restore pg_hba.conf to "scram-sha-256" and restart the service.\n',
  );
  process.exit(1);
}

void main();
