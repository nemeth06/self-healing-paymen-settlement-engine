import { Effect, Ref } from "effect";
import type { BlockchainService, UnsignedTx } from "../services/BlockchainService.js";
import type { StorageService } from "../services/StorageService.js";
import type { ConfigService } from "../services/ConfigService.js";
import { isTransient, formatError, SettlementError } from "../errors/index.js";
import type { Transaction } from "../db/schema.js";
import {
  buildUnsignedTx,
  signTransaction,
  validateTransaction,
} from "../utils/gas.js";
import type { ethers } from "ethers";

/**
 * Processes a single transaction through the settlement pipeline.
 */


export const processTransaction = (
  txn: Transaction,
  nonceRef: Ref.Ref<number>,
  signer: ethers.Signer,
  blockchain: BlockchainService,
  storage: StorageService,
  config: ConfigService
): Effect.Effect<void, SettlementError> => // REMOVED ', unknown' as requested
  Effect.gen(function* (_) {
    // Log and mark as processing
    yield* _(Effect.log(`Processing transaction ${txn.id}: to=${txn.toAddress}`));
    yield* _(storage.updateTransactionStatus(txn.id, "PROCESSING"));

    const fromAddress = yield* _(Effect.promise(() => signer.getAddress()));

    // Validate transaction parameters
    yield* _(
      validateTransaction({
        to: txn.toAddress,
        from: fromAddress,
        value: txn.value,
        data: txn.calldata,
        gasLimit: txn.gasLimit,
        nonce: 0,
        chainId: config.rpcId,
      })
    );

    // Get nonce from Ref or chain
    let nonce = yield* _(Ref.get(nonceRef));
    if (nonce < 0) {
      // Assuming getNonce returns an Effect based on your architecture
      nonce = yield* _(blockchain.getNonce(fromAddress));
      yield* _(Ref.set(nonceRef, nonce));
      yield* _(Effect.log(`Initialized nonce from chain: ${nonce}`));
    }

    // Define the core settlement logic as a sub-effect
    // We compose this with yield* because the dependencies return Effects, not Promises
    const settlementAttempt = Effect.gen(function* (_) {
      // 1. Get Gas Price
      const gasPrice = yield* _(blockchain.getGasPrice());
      yield* _(Effect.log(`got gas price: ${gasPrice}`));

      // 2. Build Object
      const unsignedTx: UnsignedTx = buildUnsignedTx({
        toAddress: txn.toAddress,
        fromAddress,
        value: txn.value,
        calldata: txn.calldata,
        nonce,
        gasLimit: txn.gasLimit,
        gasPrice, // This is now correctly a bigint
        chainId: config.rpcId,
      });

      yield* _(Effect.log(`built unsigned tx: ${JSON.stringify(unsignedTx)}`));

      // 3. Sign
      const signedTx = yield* _(signTransaction(signer, unsignedTx));

      yield* _(Effect.log(`signed tx: ${signedTx}`));

      // 4. Send
      const txHash = yield* _(blockchain.sendRawTx(signedTx));
      
      yield* _(Effect.log(`txHash: ${txHash}`));

      // 5. Success Updates
      yield* _(storage.updateTransactionStatus(txn.id, "SETTLED", txHash));
      yield* _(Ref.set(nonceRef, nonce + 1));

      yield* _(Effect.log(`Successfully processed transaction: ${signedTx}`));

    });

    // Execute the attempt with error handling
    yield* _(
      settlementAttempt.pipe(
        // Map any error from the services to a SettlementError
        // This ensures the next catchAll receives a known type
        
       Effect.mapError((error) => {
            // If it's already a SettlementError, pass it through
            if (typeof error === 'object' && error !== null && '_tag' in error) {
                return error as SettlementError;
            }
            
            // Otherwise, wrap the unknown error (likely from ethers)
            return {
                _tag: "DbError", // or "BlockchainError"
                message: error instanceof Error ? error.message : JSON.stringify(error),
                operation: "processTransaction"
            } as SettlementError;
        }),

        
        // Handle Logic (Retry vs DLQ)
        Effect.catchAll((err: SettlementError) =>
          Effect.gen(function* (_) {
            yield* _(storage.recordTransactionError(txn.id, formatError(err)));

            if (isTransient(err)) {
              if (txn.retryCount < config.maxRetries) {
                yield* _(
                  Effect.log(
                    `Transient error for ${txn.id}: ${formatError(err)}. Retrying (${txn.retryCount + 1}/${config.maxRetries})`
                  )
                );
                yield* _(storage.incrementRetryCount(txn.id));

                if (err._tag === "NonceToLow" && 'currentNonce' in err) {
                   // Ensure types match for nonce correction
                   yield* _(Ref.set(nonceRef, (err as any).currentNonce));
                }

                yield* _(storage.updateTransactionStatus(txn.id, "PENDING"));
              } else {
                yield* _(
                  storage.moveToDeadLetterQueue(
                    txn.id,
                    `Transient error after ${txn.retryCount} retries`,
                    formatError(err)
                  )
                );
                yield* _(Effect.log(`Transaction moved to DLQ: ${txn.id}`));
              }
            } else {
              // Permanent error
              yield* _(
                storage.moveToDeadLetterQueue(
                  txn.id,
                  "Permanent error",
                  formatError(err)
                )
              );
              yield* _(Effect.log(`Transaction failed permanently: ${txn.id}`));
            }

            // Fail with the typed error so the parent knows it failed
            return yield* _(Effect.fail(err));
          })
        )
      )
    );
  });