import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Ref } from "effect";
import type { ethers } from "ethers";
import { processTransaction } from "./TransactionProcessor.js";
import type {
  BlockchainService,
  UnsignedTx,
} from "../services/BlockchainService.js";
import type { StorageService } from "../services/StorageService.js";
import type { ConfigService } from "../services/ConfigService.js";
import type { Transaction } from "../db/schema.js";
import type { SettlementError } from "../errors/index.js";

import { Exit } from "effect"; // Add this import

/**
 * Mock utilities and fixtures
 */

const createMockTransaction = (overrides?: Partial<Transaction>): Transaction => ({
  id: "tx-1",
  hash: null,
  status: "PENDING",
  toAddress: "0x1234567890123456789012345678901234567890",
  value: "1000000000000000000", // 1 ETH in wei
  calldata: "0x",
  gasLimit: "21000",
  retryCount: 0,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createMockSigner = (): ethers.Signer => ({
  getAddress: vi.fn(async () => "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"),
  signTransaction: vi.fn(),
  signMessage: vi.fn(),
  signTypedData: vi.fn(),
  getBalance: vi.fn(),
  getTransactionCount: vi.fn(),
  estimateGas: vi.fn(),
  call: vi.fn(),
  sendTransaction: vi.fn(),
  _isSigner: true,
} as any);

/**
 * Test Suite: TransactionProcessor
 */
describe("TransactionProcessor", () => {
  let mockBlockchain: BlockchainService;
  let mockStorage: StorageService;
  let mockConfig: ConfigService;
  let mockSigner: ethers.Signer;
  let nonceRef: Ref.Ref<number>;

  beforeEach(async () => {
    // Initialize nonce ref
    nonceRef = await Effect.runPromise(Ref.make<number>(5));

    // Create mock blockchain service
    mockBlockchain = {
      getNonce: vi.fn(() => Effect.succeed(5)),
      estimateGas: vi.fn(() => Effect.succeed(BigInt(21000))),
      getGasPrice: vi.fn(() => Effect.succeed(BigInt(20000000000))), // 20 gwei
      sendRawTx: vi.fn(() => Effect.succeed("0xabcdef123456")),
      getTxReceipt: vi.fn(() => Effect.succeed(null)),
      waitForTx: vi.fn(() => Effect.succeed(null)),
    };

    // Create mock storage service
    mockStorage = {
      getPendingTransactions: vi.fn(() => Effect.succeed([])),
      getTransactionsByStatus: vi.fn(() => Effect.succeed([])),
      getTransaction: vi.fn(() => Effect.succeed(undefined)),
      getTransactionByHash: vi.fn(() => Effect.succeed(undefined)),
      updateTransactionStatus: vi.fn(() => Effect.succeed(void 0)),
      incrementRetryCount: vi.fn(() => Effect.succeed(void 0)),
      recordTransactionError: vi.fn(() => Effect.succeed(void 0)),
      moveToDeadLetterQueue: vi.fn(() => Effect.succeed(void 0)),
      getDeadLetterQueueEntries: vi.fn(() => Effect.succeed([])),
    };

    // Create mock config service
    mockConfig = {
      rpcUrl: "http://localhost:8545",
      rpcId: 31337,
      privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
      databaseUrl: "postgresql://localhost/test",
      pollIntervalMs: 2000,
      maxRetries: 3,
      maxGasPriceMultiplier: 2.0,
    };

    mockSigner = createMockSigner();
  });

  /**
   * Test Case 1: Happy Path
   * - Transaction is processed successfully
   * - Transaction status is updated to "SETTLED"
   * - Nonce ref is incremented
   * - TxHash is recorded
   */
  it("should process a transaction successfully and update status to SETTLED", async () => {
    const txn = createMockTransaction();
    const finalTxHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    // Setup mocks for happy path
    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.succeed(finalTxHash)
    );

    // Run the process transaction effect
    await Effect.runPromise(
      processTransaction(txn, nonceRef, mockSigner, mockBlockchain, mockStorage, mockConfig)
    );

    // Verify that updateTransactionStatus was called with SETTLED
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      txn.id,
      "SETTLED",
      finalTxHash
    );

    // Verify nonce was incremented
    const finalNonce = await Effect.runPromise(Ref.get(nonceRef));
    expect(finalNonce).toBe(6);

    // Verify transaction status was initially set to PROCESSING
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      txn.id,
      "PROCESSING"
    );
  });

  /**
   * Test Case 2: Transient Error - Nonce Too Low
   * - Simulate NonceToLow error from sendRawTx
   * - Verify that retry count is incremented
   * - Verify that status is set back to PENDING
   * - Verify that nonce ref is updated to the correct value
   * - Verify that the error is caught (swallowed)
   */
  it("should handle NonceToLow error transiently: retry and update nonce", async () => {
    const txn = createMockTransaction({ retryCount: 0 });
    const nonceToLowError: SettlementError = {
      _tag: "NonceToLow",
      currentNonce: 7,
      txNonce: 5,
      address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    };

    // Mock sendRawTx to fail with NonceToLow
    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.fail(nonceToLowError)
    );

const exit = await Effect.runPromiseExit(
      processTransaction(txn, nonceRef, mockSigner, mockBlockchain, mockStorage, mockConfig)
    );

    // Verify it failed
    expect(Exit.isFailure(exit)).toBe(true);
    
    // Extract the error from the Exit cause
    if (Exit.isFailure(exit)) {
      // Unsafely unwrap the cause for testing purposes (assuming it's the specific failure)
      // In Effect, failures are wrapped in a Cause object
      const errorThrown = (exit.cause as any).failureOrCause; // Basic access, or inspect structure
      
      // Better way to check specific failure in tests:
      // Check if the cause contains our specific failure tag
      const causeStr = String(exit.cause);
      expect(causeStr).toContain("NonceToLow");
    }

    // Verify side effects (Logic Tests)
    
    // 1. Nonce updated?
    const updatedNonce = await Effect.runPromise(Ref.get(nonceRef));
    expect(updatedNonce).toBe(7);

    // 2. Retry count incremented?
    expect(mockStorage.incrementRetryCount).toHaveBeenCalledWith(txn.id);

    // 3. Status reset to PENDING?
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      txn.id,
      "PENDING"
    );
});

  /**
   * Test Case 3: Permanent Error - Execution Reverted
   * - Simulate ExecutionReverted error from sendRawTx
   * - Verify that moveToDeadLetterQueue is called
   * - Verify that status is updated to FAILED
   * - Verify that error is recorded
   */
  it("should handle ExecutionReverted error permanently: move to DLQ", async () => {
    const txn = createMockTransaction({ retryCount: 0 });
    const executionRevertedError: SettlementError = {
      _tag: "ExecutionReverted",
      reason: "Insufficient balance",
      data: "0x",
    };

    // Mock sendRawTx to fail with ExecutionReverted
    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.fail(executionRevertedError)
    );

    // FIX: Use runPromiseExit
    const exit = await Effect.runPromiseExit(
      processTransaction(txn, nonceRef, mockSigner, mockBlockchain, mockStorage, mockConfig)
    );

    expect(Exit.isFailure(exit)).toBe(true);

    // Verify moveToDeadLetterQueue was called with permanent error message
    expect(mockStorage.moveToDeadLetterQueue).toHaveBeenCalledWith(
      txn.id,
      "Permanent Error",
      expect.stringContaining("Execution reverted")
    );

    // Verify incrementRetryCount was NOT called
    expect(mockStorage.incrementRetryCount).not.toHaveBeenCalled();
  });

  /**
   * Test Case 4: Max Retries Exceeded
   * - Simulate multiple transient errors
   * - Verify that after maxRetries, transaction is moved to DLQ
   */
  it("should move to DLQ when max retries exceeded for transient error", async () => {
    const txn = createMockTransaction({ retryCount: 3 }); // At max retries
    const transientError: SettlementError = {
      _tag: "NetworkError",
      message: "Network timeout",
      code: "NETWORK_ERROR",
    };

    // Mock sendRawTx to fail with NetworkError
    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.fail(transientError)
    );

    // Run the effect
    let errorThrown: SettlementError | null = null;
    try {
      await Effect.runPromise(
        processTransaction(txn, nonceRef, mockSigner, mockBlockchain, mockStorage, mockConfig)
      );
    } catch (err) {
      errorThrown = err as SettlementError;
    }

    // Verify error is propagated
    expect(errorThrown).not.toBeNull();

    // Verify moveToDeadLetterQueue was called (max retries exceeded)
    expect(mockStorage.moveToDeadLetterQueue).toHaveBeenCalledWith(
      txn.id,
      `Max retries exceeded`,
      expect.stringContaining("Network")
    );

    // Verify status was NOT set back to PENDING (should go to DLQ)
    expect(mockStorage.updateTransactionStatus).not.toHaveBeenCalledWith(
      txn.id,
      "PENDING"
    );
  });

  /**
   * Test Case 5: ReplacementFeeTooLow - Transient Error
   * - Simulate ReplacementFeeTooLow error
   * - Verify that it's treated as transient and retried
   */
  it("should handle ReplacementFeeTooLow as transient error", async () => {
    const txn = createMockTransaction({ retryCount: 0 });
    const feeError: SettlementError = {
      _tag: "ReplacementFeeTooLow",
      txHash: "0xabcd1234",
      currentGasPrice: BigInt(20000000000),
      txGasPrice: BigInt(10000000000),
    };

    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.fail(feeError)
    );

    let errorThrown: SettlementError | null = null;
    try {
      await Effect.runPromise(
        processTransaction(txn, nonceRef, mockSigner, mockBlockchain, mockStorage, mockConfig)
      );
    } catch (err) {
      errorThrown = err as SettlementError;
    }

    // Verify retry count was incremented (transient)
    expect(mockStorage.incrementRetryCount).toHaveBeenCalledWith(txn.id);

    // Verify status was set back to PENDING
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      txn.id,
      "PENDING"
    );
  });

  /**
   * Test Case 6: InsufficientFunds - Permanent Error
   * - Simulate InsufficientFunds error
   * - Verify that it's treated as permanent
   */
  it("should handle InsufficientFunds as permanent error", async () => {
    const txn = createMockTransaction({ retryCount: 0 });
    const fundError: SettlementError = {
      _tag: "InsufficientFunds",
      address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      requiredBalance: "5000000000000000000",
      actualBalance: "1000000000000000000",
    };

    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.fail(fundError)
    );

    let errorThrown: SettlementError | null = null;
    try {
      await Effect.runPromise(
        processTransaction(txn, nonceRef, mockSigner, mockBlockchain, mockStorage, mockConfig)
      );
    } catch (err) {
      errorThrown = err as SettlementError;
    }

    // Verify moveToDeadLetterQueue was called (permanent)
    expect(mockStorage.moveToDeadLetterQueue).toHaveBeenCalledWith(
      txn.id,
      "Permanent Error",
      expect.stringContaining("Insufficient")
    );

    // Verify retry count was NOT incremented
    expect(mockStorage.incrementRetryCount).not.toHaveBeenCalled();
  });

  /**
   * Test Case 7: Nonce initialization from chain
   * - Set nonceRef to -1 (uninitialized)
   * - Verify that getNonce is called from blockchain
   */
  it("should initialize nonce from chain when uninitialized", async () => {
    // Set nonce to -1 (uninitialized)
    const uninitializedNonce = await Effect.runPromise(Ref.make<number>(-1));

    const txn = createMockTransaction();
    const expectedChainNonce = 42;

    vi.mocked(mockBlockchain.getNonce).mockReturnValue(
      Effect.succeed(expectedChainNonce)
    );
    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.succeed("0xabcdef123456")
    );

    await Effect.runPromise(
      processTransaction(txn, uninitializedNonce, mockSigner, mockBlockchain, mockStorage, mockConfig)
    );

    // Verify getNonce was called
    expect(mockBlockchain.getNonce).toHaveBeenCalledWith(
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
    );

    // Verify nonce was set to chain value
    const finalNonce = await Effect.runPromise(Ref.get(uninitializedNonce));
    expect(finalNonce).toBe(expectedChainNonce + 1); // incremented after success
  });
});
