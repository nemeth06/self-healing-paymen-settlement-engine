import { Effect, Scope } from "effect";
import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DbClient = PostgresJsDatabase<typeof schema>;

export const initDb = (databaseUrl: string) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const client = postgres(databaseUrl, { max: 10, idle_timeout: 30 });
          return drizzle(client, { schema });
        },
        catch: (error) => new Error(`DB init failed: ${String(error)}`),
      }),
      () => Effect.void
    )
  );
