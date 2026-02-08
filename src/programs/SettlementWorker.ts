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
    const nonceRef = yield* _(Ref.make<number>(-1)); // Start with -1 to indicate uninitialized

    const activeTxIds = yield* _(Ref.make(new Set<string>()));
    
    // Create a bounded queue for work distribution
    const workQueue = yield* _(Queue.bounded<WorkItem>(100));

    // FIX 1: Supervisor.track is a constant Effect, not a function
    const supervisor = yield* _(Supervisor.track);

    // Producer: poll DB for PENDING transactions
    const producer = Effect.gen(function* (_) {
      yield* _(Effect.log("[Producer] Started"));


      while (true) {

        yield* _(
          Effect.gen(function* (_) {

          const pending = yield* _(storage.getPendingTransactions());

          // 🛡️ Guard: Ensure pending is actually an array before filtering
          if (!pending || !Array.isArray(pending)) {
            return; // Skip this poll cycle if DB returns junk
          }

          // Filter out transactions that are already in the queue or being processed
          const newWork = yield* _(
            Ref.modify(activeTxIds, (currentSet) => {
              const nextSet = new Set(currentSet);
              const toAdd = pending.filter((tx) => !nextSet.has(tx.id));
              
              // Mark new items as active immediately
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
          }
          //hearthbeat log for idle state
          else {
             yield* _(Effect.log(`[Producer] Idle... (Next poll in ${config.pollIntervalMs}ms)`));
          }
        }).pipe(
            // 1. Catch expected failures (Effect.fail)
            Effect.catchAll((error) => 
              Effect.logError(`[Producer] Polling Failure: ${String(error)}`)
            ),
            // 2. Catch unexpected defects (throw new Error, TypeError, etc.)
            //    This prevents the fiber from dying if the code crashes.
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
          
          // Helper to remove ID from active set (run in finally block)
          const releaseId = Ref.update(activeTxIds, (set) => {
            const next = new Set(set);
            next.delete(txn.id);
            return next;
          });

          // Process transaction with retry schedule for transient errors
          yield* _(
            processTransaction(txn, nonceRef, signer, blockchain, storage, config).pipe(
              // Modify retry to only trigger IF the error is transient
              Effect.retry(
                Schedule.exponential(Duration.millis(100)).pipe(
                  Schedule.intersect(Schedule.recurs(2)),
                  // 🛡️ ONLY retry if our logic says it's transient
                  Schedule.whileInput((err: SettlementError) => isTransient(err))
                )
              ),
              Effect.catchAll((error) =>
                Effect.logError(
                  `[Worker-${workerId}] Terminated processing ${txn.id}: ${formatError(error)}`
                )
              ),
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

    // Ensure the generator runs forever and matches Effect<never>
    return yield* _(Effect.never);
  });