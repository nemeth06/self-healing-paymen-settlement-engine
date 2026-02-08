import "dotenv/config";
import { Effect } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm/sql";
import postgres from "postgres";
import * as schema from "../db/schema.js";
import { transactions } from "../db/schema.js";
import { ethers } from "ethers";

/**
 * Seed script to insert test transactions into the database
 */
const seedDatabase = Effect.gen(function* (_) {
  const dbUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/settlement_engine";
  const client = postgres(dbUrl);
  const db = drizzle(client, { schema });

  yield* _(
    Effect.tryPromise({
      try: () =>
        db.execute(sql`TRUNCATE TABLE ${sql.raw("transactions")} RESTART IDENTITY CASCADE`),
      catch: (e) => new Error(`Failed to clear transactions table: ${String(e)}`),
    })
  );

  yield* _(Effect.log("✓ Cleared transactions table"));


  yield* _(
    Effect.tryPromise({
      try: () =>
        db.execute(sql`TRUNCATE TABLE ${sql.raw("dead_letter_queue")} RESTART IDENTITY CASCADE`),
      catch: (e) => new Error(`Failed to clear dead_letter_queue table: ${String(e)}`),
    })
  );


  yield* _(Effect.log("✓ Cleared dead_letter_queue table"));

  const testTransactions = [
    {
      toAddress: "0x1234567890123456789012345678901234567890",
      value: "1",
      calldata: "0x",
      gasLimit: "21000",
    },
    {
      toAddress: "0x0987654321098765432109876543210987654321",
      value: "10",
      calldata: "0x",
      gasLimit: "21000",
    },
    {
      toAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      value: "10",
      calldata: "0x",
      gasLimit: "21000",
    },
  ];

  yield* _(Effect.log(`Seeding database with ${testTransactions.length} test transactions...`));

  yield* _(
    Effect.tryPromise({
      try: () => db.insert(transactions).values(testTransactions),
      catch: (e) => new Error(`Seed failed: ${String(e)}`),
    })
  );

  yield* _(Effect.log("✓ Test transactions inserted"));
  yield* _(Effect.promise(() => client.end()));
});

// Run the seed
Effect.runPromise(seedDatabase).catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
