import { startServer } from "./server";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required, e.g. postgres://user:pass@host/db");
  process.exit(1);
}

const handle = await startServer({
  databaseUrl,
  adminToken: process.env.SLOPWATCH_ADMIN_TOKEN,
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
});

console.log(`slopwatch server listening on ${handle.url}`);
