/**
 * Where the sandbox E2E (T74) runs: its own ports and its own database, so it never
 * touches a developer's servers or the `wildworth` database. Read by playwright.config.ts (to
 * start the servers) and by the specs; override with E2E_* environment variables.
 */
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8100);
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;
/** Recreated on every run by scripts/e2e-backend.sh; its name must contain "e2e". */
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql+psycopg://wildworth:wildworth@localhost:5432/wildworth_e2e";
