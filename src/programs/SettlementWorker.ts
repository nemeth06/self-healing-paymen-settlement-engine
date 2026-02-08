import { Effect, Queue, Ref, Supervisor, Duration, Schedule } from "effect";
import type { BlockchainService } from "../services/BlockchainService.js";
import type { StorageService } from "../services/StorageService.js";
import type { ConfigService } from "../services/ConfigService.js";
import type { ethers } from "ethers";
import { processTransaction } from "./TransactionProcessor.js";

import type { Transaction } from "../db/schema.js";

import { 
  type SettlementError, 
  parseRpcError, 
  isTransient, 
  formatError 
} from "../errors/index.js";

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
    const nonceRef = yield* _(Ref.make<number>(-1));

    const activeTxIds = yield* _(Ref.make(new Set<string>()));
    
    // Create a bounded queue for work distribution
    const workQueue = yield* _(Queue.bounded<WorkItem>(100));

    // Supervisor tracks the fibers
    const supervisor = yield* _(Supervisor.track);

    // 🔒 MUTEX: Create a Semaphore with 1 permit. 
    // This acts as a lock to ensure sequential processing of nonces.
    const gate = yield* _(Effect.makeSemaphore(1));

    // Producer: poll DB for PENDING transactions
    const producer = Effect.gen(function* (_) {
      yield* _(Effect.log("[Producer] Started"));

      while (true) {
        yield* _(
          Effect.gen(function* (_) {
            const pending = yield* _(storage.getPendingTransactions());

            if (!pending || !Array.isArray(pending)) {
              return;
            }

            // Filter out transactions that are already in the queue or being processed
            const newWork = yield* _(
              Ref.modify(activeTxIds, (currentSet) => {
                const nextSet = new Set(currentSet);
                const toAdd = pending.filter((tx) => !nextSet.has(tx.id));
                toAdd.forEach((tx) => nextSet.add(tx.id));
                return [toAdd, nextSet];
              })
            );

            if (newWork.length > 0) {
              yield* _(
                Effect.log(`[Producer] Enqueueing ${newWork.length} new transactions`)
              );

              yield* _(
                Effect.all(
                  newWork.map((txn) => Queue.offer(workQueue, { txn })),
                  { concurrency: "unbounded" }
                )
              );
            } else {
               yield* _(Effect.log(`[Producer] Idle... (Next poll in ${config.pollIntervalMs}ms)`));
            }
          }).pipe(
            Effect.catchAll((error) => 
              Effect.logError(`[Producer] Polling Failure: ${String(error)}`)
            ),
            Effect.catchAllCause((cause) => 
              Effect.logError(`[Producer] CRITICAL DEFECT (Recovered): ${cause}`)
            )
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
          
          const releaseId = Ref.update(activeTxIds, (set) => {
            const next = new Set(set);
            next.delete(txn.id);
            return next;
          });

          yield* _(
            // 1. We create the "attempt" effect
            processTransaction(txn, nonceRef, signer, blockchain, storage, config).pipe(
              
              // 🔒 CRITICAL SECTION START
              // Only one worker can be executing this block (Get Nonce -> Sign -> Send) at a time.
              // This strictly prevents the nonce race condition.
              gate.withPermits(1),
              // 🔒 CRITICAL SECTION END

              // 2. Retry Logic
              // If the locked section fails (e.g. network error), the lock is released.
              // The retry schedule waits (backoff), then tries to acquire the lock again.
              Effect.retry(
                Schedule.exponential(Duration.millis(100)).pipe(
                  Schedule.intersect(Schedule.recurs(2)),
                  // Guard: Only retry transient errors
                  Schedule.whileInput((err: SettlementError) => isTransient(err))
                )
              ),
              
              // 3. Error Logging
              Effect.catchAll((error) =>
                Effect.logError(
                  `[Worker-${workerId}] Terminated processing ${txn.id}: ${formatError(error)}`
                )
              ),
              
              // 4. Cleanup
              Effect.ensuring(releaseId)
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
    // Note: With the semaphore, actual execution is sequential, 
    // but multiple workers allow one to wait on retry backoff while another works.
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
      Effect.log(`[Settlement] Worker started with ${workerCount} fibers (Sequential Execution Enforcement Active)`)
    );

    return yield* _(Effect.never);
  });