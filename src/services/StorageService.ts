import { Effect } from "effect";
import { sql } from "drizzle-orm";
import {
  eq,
  and,
  lte,
  desc,
  asc,
} from "drizzle-orm";
import {
  transactions,
  deadLetterQueue,
  type Transaction,
  type NewDeadLetterQueueEntry,
} from "../db/schema.js";
import { SettlementError } from "../errors/index.js";

/**
 * Service interface for storage operations
 * All methods return Effect to enable proper error handling and composition
 */
export interface StorageService {
  /**
   * Get all pending transactions ordered by creation time
   */
  getPendingTransactions(): Effect.Effect<Transaction[], SettlementError>;

  /**
   * Get transactions with specific statuses
   */
  getTransactionsByStatus(
    status: "PENDING" | "PROCESSING" | "SETTLED" | "FAILED"
  ): Effect.Effect<Transaction[], SettlementError>;

  /**
   * Get a single transaction by ID
   */
  getTransaction(
    id: string
  ): Effect.Effect<Transaction | undefined, SettlementError>;

  /**
   * Get a transaction by hash
   */
  getTransactionByHash(
    hash: string
  ): Effect.Effect<Transaction | undefined, SettlementError>;

  /**
   * Update transaction status
   */
  updateTransactionStatus(
    id: string,
    status: "PENDING" | "PROCESSING" | "SETTLED" | "FAILED",
    hash?: string
  ): Effect.Effect<void, SettlementError>;

  /**
   * Increment retry count for a transaction
   */
  incrementRetryCount(id: string): Effect.Effect<void, SettlementError>;

  /**
   * Record error message for a transaction
   */
  recordTransactionError(id: string, error: string): Effect.Effect<void, SettlementError>;

  /**
   * Move transaction to dead letter queue
   */
  moveToDeadLetterQueue(
    transactionId: string,
    reason: string,
    errorDetails?: string
  ): Effect.Effect<void, SettlementError>;

  /**
   * Get all entries in the dead letter queue
   */
  getDeadLetterQueueEntries(): Effect.Effect<
    Array<{ transactionId: string; reason: string; enqueuedAt: Date }>,
    SettlementError
  >;
}

/**
 * Create a StorageService instance
 * Takes a Drizzle database client and returns the service interface
 */
export const StorageService = (db: any): StorageService => {
  const getPendingTransactions = (): Effect.Effect<
    Transaction[],
    SettlementError
  > =>
    Effect.tryPromise({
      try: async () => {
        const pending = await db
          .select()
          .from(transactions)
          .where(eq(transactions.status, "PENDING"))
          .orderBy(asc(transactions.createdAt));
        return pending;
      },
      catch: (error) =>
        ({
          _tag: "DbError",
          message: String(error),
          operation: "getPendingTransactions",
        }) as SettlementError,
    });

  const getTransactionsByStatus = (
    status: "PENDING" | "PROCESSING" | "SETTLED" | "FAILED"
  ): Effect.Effect<Transaction[], SettlementError> =>
    Effect.tryPromise({
      try: async () => {
        const txns = await db
          .select()
          .from(transactions)
          .where(eq(transactions.status, status))
          .orderBy(desc(transactions.updatedAt));
        return txns;
      },
      catch: (error) =>
        ({
          _tag: "DbError",
          message: String(error),
          operation: "getTransactionsByStatus",
        }) as SettlementError,
    });

  const getTransaction = (
    id: string
  ): Effect.Effect<Transaction | undefined, SettlementError> =>
    Effect.tryPromise({
      try: async () => {
        const txn = await db
          .select()
          .from(transactions)
          .where(eq(transactions.id, id))
          .limit(1);
        return txn[0];
      },
      catch: (error) =>
        ({
          _tag: "DbError",
          message: String(error),
          operation: "getTransaction",
        }) as SettlementError,
    });

  const getTransactionByHash = (
    hash: string
  ): Effect.Effect<Transaction | undefined, SettlementError> =>
    Effect.tryPromise({
      try: async () => {
        const txn = await db
          .select()
          .from(transactions)
          .where(eq(transactions.hash, hash))
          .limit(1);
        return txn[0];
      },
      catch: (error) =>
        ({
          _tag: "DbError",
          message: String(error),
          operation: "getTransactionByHash",
        }) as SettlementError,
    });

  const updateTransactionStatus = (
    id: string,
    status: "PENDING" | "PROCESSING" | "SETTLED" | "FAILED",
    hash?: string
  ): Effect.Effect<void, SettlementError> =>
    Effect.try({
      try: async () => {
        const updates: any = {
          status,
          updatedAt: new Date(),
        };
        if (hash) {
          updates.hash = hash;
        }
        await db
          .update(transactions)
          .set(updates)
          .where(eq(transactions.id, id));
      },
      catch: (error) =>
        ({
          _tag: "DbError",
          message: String(error),
          operation: "updateTransactionStatus",
        }) as SettlementError,
    });

  const incrementRetryCount = (id: string): Effect.Effect<void, SettlementError> =>
    Effect.try({
      try: async () => {
        await db
          .update(transactions)
          .set({
            retryCount: sql`${transactions.retryCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(transactions.id, id));
      },
      catch: (error) =>
        ({
          _tag: "DbError",
          message: String(error),
          operation: "incrementRetryCount",
        }) as SettlementError,
    });

  const recordTransactionError = (
    id: string,
    error: string
  ): Effect.Effect<void, SettlementError> =>
    Effect.try({
      try: async () => {
        await db
          .update(transactions)
          .set({
            lastError: error,
            updatedAt: new Date(),
          })
          .where(eq(transactions.id, id));
      },
      catch: (error) =>
        ({
          _tag: "DbError",
          message: String(error),
          operation: "recordTransactionError",
        }) as SettlementError,
    });

  const moveToDeadLetterQueue = (
    transactionId: string,
    reason: string,
    errorDetails?: string
  ): Effect.Effect<void, SettlementError> =>
    Effect.try({
      try: async () => {
        // Insert into DLQ
        const entry: NewDeadLetterQueueEntry = {
          transactionId,
          reason,
          errorDetails,
        };
        await db.insert(deadLetterQueue).values(entry);

        // Update transaction status to FAILED
        await db
          .update(transactions)
          .set({
            status: "FAILED",
            updatedAt: new Date(),
          })
          .where(eq(transactions.id, transactionId));
      },
      catch: (error) =>
        ({
          _tag: "DbError",
          message: String(error),
          operation: "moveToDeadLetterQueue",
        }) as SettlementError,
    });

  const getDeadLetterQueueEntries = (): Effect.Effect<
    Array<{ transactionId: string; reason: string; enqueuedAt: Date }>,
    SettlementError
  > =>
    Effect.tryPromise({
      try: async () => {
        const entries = await db
          .select({
            transactionId: deadLetterQueue.transactionId,
            reason: deadLetterQueue.reason,
            enqueuedAt: deadLetterQueue.enqueuedAt,
          })
          .from(deadLetterQueue)
          .orderBy(desc(deadLetterQueue.enqueuedAt));
        return entries;
      },
      catch: (error) =>
        ({
          _tag: "DbError",
          message: String(error),
          operation: "getDeadLetterQueueEntries",
        }) as SettlementError,
    });

  return {
    getPendingTransactions,
    getTransactionsByStatus,
    getTransaction,
    getTransactionByHash,
    updateTransactionStatus,
    incrementRetryCount,
    recordTransactionError,
    moveToDeadLetterQueue,
    getDeadLetterQueueEntries,
  };
};
