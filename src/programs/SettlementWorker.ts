import { Effect, Queue, Ref, Supervisor, Duration, Schedule } from "effect";
import type { BlockchainService } from "../services/BlockchainService.js";
import type { StorageService } from "../services/StorageService.js";
import type { ConfigService } from "../services/ConfigService.js";
import type { ethers } from "ethers";
import { processTransaction } from "./TransactionProcessor.js";

import type { Transaction } from "../db/schema.js";

// Placeholder for the error type based on your spec
// If you have a specific file for this, import it instead.
export interface SettlementError {
  _tag: "SettlementError";
  message: string;
}

/**
 * Work item in the settlement queue
 */
interface WorkItem {
  txn: Transaction;
}

export const settlementWorker = (
  blockchain: BlockchainService,
  storage: StorageService,
  config: ConfigService,
  signer: ethers.Signer
): Effect.Effect<never, SettlementError> =>
  Effect.gen(function* (_) {
    // Initialize the nonce reference (in-memory tracking)
    const nonceRef = yield* _(Ref.make<number>(0));

    // Create a bounded queue for work distribution
    const workQueue = yield* _(Queue.bounded<WorkItem>(100));

    // FIX 1: Supervisor.track is a constant Effect, not a function
    const supervisor = yield* _(Supervisor.track);

    // Producer: poll DB for PENDING transactions
    const producer = Effect.gen(function* (_) {
      while (true) {
        const pending = yield* _(storage.getPendingTransactions());

        yield* _(
          Effect.log(`[Producer] Found ${pending.length} pending transactions`)
        );

        yield* _(
          Effect.all(
            pending.map((txn) => Queue.offer(workQueue, { txn })),
            { concurrency: "unbounded" }
          )
        );

        yield* _(Effect.sleep(Duration.millis(config.pollIntervalMs)));
      }
    });

    // Worker: process transactions from queue with retry logic
    const worker = (workerId: number) =>
      Effect.gen(function* (_) {
        yield* _(Effect.log(`[Worker-${workerId}] Started`));

        while (true) {
          const { txn } = yield* _(Queue.take(workQueue));

          yield* _(Effect.log(`[Worker-${workerId}] Processing ${txn.id}`));

          // Process transaction with retry schedule for transient errors
          yield* _(
            processTransaction(txn, nonceRef, signer, blockchain, storage, config).pipe(
              // FIX 2: Correct Retry Schedule API
              // Intersect 'exponential' (delay) with 'recurs' (limit count)
              Effect.retry(
                Schedule.exponential(Duration.millis(100)).pipe(
                  Schedule.intersect(Schedule.recurs(2))
                )
              ),
              // Swallow errors to keep worker alive
              Effect.catchAll((error) =>
                Effect.log(
                  `[Worker-${workerId}] Error processing ${txn.id}: ${String(error)}`
                )
              )
            )
          );
        }
      });

    // Fork producer fiber
    yield* _(
      producer.pipe(
        Effect.supervised(supervisor),
        Effect.fork
      )
    );

    // Fork worker fibers
    const workerCount = 2;
    yield* _(
      Effect.all(
        Array.from({ length: workerCount }, (_, i) =>
          worker(i + 1).pipe(
            Effect.supervised(supervisor),
            Effect.fork
          )
        ),
        { concurrency: workerCount }
      )
    );

    yield* _(
      Effect.log(`[Settlement] Worker started with ${workerCount} worker fibers`)
    );

    // FIX 3: Ensure the generator runs forever and matches Effect<never>
    return yield* _(Effect.never);
  });