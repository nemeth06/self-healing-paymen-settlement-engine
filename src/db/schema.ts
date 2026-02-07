import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  timestamp,
  pgEnum,
  bigint,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";

// Enums for transaction status
export const transactionStatusEnum = pgEnum("transaction_status", [
  "PENDING",
  "PROCESSING",
  "SETTLED",
  "FAILED",
]);

/**
 * Transactions Table
 * Represents settlement transactions to be executed on-chain
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Hash of settled transaction (null until sent)
    hash: varchar("hash", { length: 66 }).unique(),
    // Current status of transaction
    status: transactionStatusEnum("status").notNull().default("PENDING"),
    // Recipient address
    toAddress: varchar("to_address", { length: 42 }).notNull(),
    // Value to transfer (in wei, stored as string to preserve precision)
    value: varchar("value", { length: 78 }).notNull(),
    // Encoded call data for contract interactions
    calldata: text("calldata").notNull().default("0x"),
    // Gas limit for transaction
    gasLimit: varchar("gas_limit", { length: 78 }).notNull(),
    // Number of times this transaction has been retried
    retryCount: integer("retry_count").notNull().default(0),
    // Last error message encountered
    lastError: text("last_error"),
    // Timestamp when record was created
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Timestamp when record was last updated
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    statusUpdatedAtIndex: index("idx_status_updated_at").on(
      table.status,
      table.updatedAt
    ),
    retryCountIndex: index("idx_retry_count").on(table.retryCount),
    hashIndex: index("idx_hash").on(table.hash),
    pendingIndex: index("idx_pending_txns").on(table.status),
  })
);

/**
 * Dead Letter Queue Table
 * Stores transactions that have exhausted all retry attempts
 */
export const deadLetterQueue = pgTable(
  "dead_letter_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Foreign key to transaction
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    // Reason for being in DLQ (descriptive error message or "Permanent Error")
    reason: text("reason").notNull(),
    // Full error details (JSON or stringified error)
    errorDetails: text("error_details"),
    // Timestamp when moved to DLQ
    enqueuedAt: timestamp("enqueued_at").notNull().defaultNow(),
  },
  (table) => ({
    transactionIdIndex: index("idx_dlq_transaction_id").on(
      table.transactionId
    ),
    enqueuedAtIndex: index("idx_dlq_enqueued_at").on(table.enqueuedAt),
  })
);

// Types derived from schema
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type DeadLetterQueueEntry = typeof deadLetterQueue.$inferSelect;
export type NewDeadLetterQueueEntry = typeof deadLetterQueue.$inferInsert;
