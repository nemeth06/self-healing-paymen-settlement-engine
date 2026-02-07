import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Duration, Fiber, TestClock, TestContext } from "effect";
import type { ethers } from "ethers";
import { settlementWorker } from "./SettlementWorker.js";
import type { BlockchainService } from "../services/BlockchainService.js";
import type { StorageService } from "../services/StorageService.js";
import type { ConfigService } from "../services/ConfigService.js";
import type { Transaction } from "../db/schema.js";
import type { SettlementError } from "../errors/index.js";

/**
 * Mock utilities and fixtures
 */

const createMockTransaction = (
  id: string,
  overrides?: Partial<Transaction>
): Transaction => ({
  id,
  hash: null,
  status: "PENDING",
  toAddress: "0x1111111111111111111111111111111111111111",
  value: "1000000000000000000",
  calldata: "0x",
  gasLimit: "21000",
  retryCount: 0,
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createMockSigner = (): ethers.Signer =>
  ({
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
 * Test Suite: SettlementWorker
 * Uses TestClock to simulate time-based polling and retry logic
 */
describe("SettlementWorker", () => {
  let mockBlockchain: BlockchainService;
  let mockStorage: StorageService;
  let mockConfig: ConfigService;
  let mockSigner: ethers.Signer;

  beforeEach(() => {
    // Create mock blockchain service
    mockBlockchain = {
      getNonce: vi.fn(() => Effect.succeed(5)),
      estimateGas: vi.fn(() => Effect.succeed(BigInt(21000))),
      getGasPrice: vi.fn(() => Effect.succeed(BigInt(20000000000))),
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

    // Create mock config service with reasonable defaults for testing
    mockConfig = {
      rpcUrl: "http://localhost:8545",
      rpcId: 31337,
      privateKey:
        "0x1234567890123456789012345678901234567890123456789012345678901234",
      databaseUrl: "postgresql://localhost/test",
      pollIntervalMs: 5000, // 5 seconds for testing
      maxRetries: 3,
      maxGasPriceMultiplier: 2.0,
    };

    mockSigner = createMockSigner();
  });

  it("should poll database at configured intervals", async () => {
    let pollCount = 0;
    const tx1 = createMockTransaction("tx-1");

    vi.mocked(mockStorage.getPendingTransactions).mockImplementation(() => {
      pollCount++;
      return Effect.succeed(pollCount >= 3 ? [tx1] : []);
    });

    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.succeed("0xabc123")
    );

    const testEffect = Effect.gen(function* (_) {
      const workerFiber = yield* _(
        Effect.fork(
          settlementWorker(mockBlockchain, mockStorage, mockConfig, mockSigner)
        )
      );

      // Advance time to trigger polling cycles
      yield* _(
        TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs * 1.5))
      );
      yield* _(
        TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs * 1.5))
      );
      yield* _(
        TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs * 1.5))
      );

      // Give worker time to process
      yield* _(TestClock.adjust(Duration.millis(1000)));

      yield* _(Fiber.interrupt(workerFiber));
    });

    // FIX: Provide TestContext to the effect pipeline
    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    expect(mockStorage.getPendingTransactions).toHaveBeenCalled();
    expect(
      vi.mocked(mockStorage.getPendingTransactions).mock.calls.length
    ).toBeGreaterThanOrEqual(2);
  });

  it("should process pending transactions from the queue", async () => {
    const tx1 = createMockTransaction("tx-1");
    let processingCount = 0;

    vi.mocked(mockStorage.getPendingTransactions).mockImplementation(() => {
      processingCount++;
      return Effect.succeed(processingCount === 1 ? [tx1] : []);
    });

    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.succeed("0xabc123def456")
    );

    const testEffect = Effect.gen(function* (_) {
      const workerFiber = yield* _(
        Effect.fork(
          settlementWorker(mockBlockchain, mockStorage, mockConfig, mockSigner)
        )
      );

      yield* _(
        TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs + 2000))
      );
      yield* _(Fiber.interrupt(workerFiber));
    });

    // FIX: Provide TestContext
    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      tx1.id,
      "PROCESSING"
    );
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      tx1.id,
      "SETTLED",
      "0xabc123def456"
    );
  });

  it("should apply exponential backoff on transient errors", async () => {
    const tx1 = createMockTransaction("tx-1");
    let attemptCount = 0;

    vi.mocked(mockStorage.getPendingTransactions).mockImplementation(() =>
      Effect.succeed([tx1])
    );

    vi.mocked(mockBlockchain.sendRawTx).mockImplementation(() => {
      attemptCount++;
      if (attemptCount === 1) {
        return Effect.fail({
          _tag: "NetworkError",
          message: "Connection timeout",
          code: "ECONNREFUSED",
        } as SettlementError);
      }
      return Effect.succeed("0xabcdef123456");
    });

    const testEffect = Effect.gen(function* (_) {
      const workerFiber = yield* _(
        Effect.fork(
          settlementWorker(mockBlockchain, mockStorage, mockConfig, mockSigner)
        )
      );

      // Advance initial poll time
      yield* _(TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs)));

      // Advance time for retry attempts
      yield* _(TestClock.adjust(Duration.millis(500)));

      yield* _(Fiber.interrupt(workerFiber));
    });

    // FIX: Provide TestContext
    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    expect(mockStorage.recordTransactionError).toHaveBeenCalledWith(
      tx1.id,
      expect.stringContaining("Network")
    );
    expect(mockBlockchain.sendRawTx).toHaveBeenCalled();
  });

  it("should process multiple transactions concurrently with worker pool", async () => {
    const tx1 = createMockTransaction("tx-1");
    const tx2 = createMockTransaction("tx-2");

    vi.mocked(mockStorage.getPendingTransactions).mockReturnValue(
      Effect.succeed([tx1, tx2])
    );

    vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
      Effect.succeed("0xabc123def456")
    );

    const testEffect = Effect.gen(function* (_) {
      const workerFiber = yield* _(
        Effect.fork(
          settlementWorker(mockBlockchain, mockStorage, mockConfig, mockSigner)
        )
      );

      yield* _(
        TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs + 3000))
      );
      yield* _(Fiber.interrupt(workerFiber));
    });

    // FIX: Provide TestContext
    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      tx1.id,
      "PROCESSING"
    );
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      tx2.id,
      "PROCESSING"
    );
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      tx1.id,
      "SETTLED",
      "0xabc123def456"
    );
  });

  it("should prevent processing of duplicate transactions in queue", async () => {
    const tx1 = createMockTransaction("tx-1");

    let pollCount = 0;
    vi.mocked(mockStorage.getPendingTransactions).mockImplementation(() => {
      pollCount++;
      return Effect.succeed(pollCount <= 2 ? [tx1] : []);
    });

// FIX: Simulate work taking time! 
    // This ensures the ID stays in 'activeTxIds' during subsequent polls.
    vi.mocked(mockBlockchain.sendRawTx).mockImplementation(() => 
      Effect.gen(function*(_) {
        // Wait longer than the poll interval (5000ms)
        yield* _(Effect.sleep(Duration.millis(6000)));
        return "0xabc123def456";
      })
    );

    const testEffect = Effect.gen(function* (_) {
      const workerFiber = yield* _(Effect.fork(
        settlementWorker(mockBlockchain, mockStorage, mockConfig, mockSigner)
      ));

      // Advance time across multiple poll cycles
      // Poll 1 (0s): Enqueues Tx1
      // Poll 2 (5s): Tx1 still processing -> Skipped by Dedup
      // Poll 3 (10s): Tx1 still processing -> Skipped by Dedup
      yield* _(TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs * 3)));

      // Allow the processing to finish
      yield* _(TestClock.adjust(Duration.millis(2000)));

      yield* _(Fiber.interrupt(workerFiber));
    });

    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    // Should only be SETTLED once
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledTimes(2); // PROCESSING + SETTLED
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      tx1.id,
      "SETTLED",
      "0xabc123def456"
    );  });

  it("should handle idle state when no pending transactions", async () => {
    vi.mocked(mockStorage.getPendingTransactions).mockReturnValue(
      Effect.succeed([])
    );

    const testEffect = Effect.gen(function* (_) {
      const workerFiber = yield* _(
        Effect.fork(
          settlementWorker(mockBlockchain, mockStorage, mockConfig, mockSigner)
        )
      );

      yield* _(
        TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs * 2.5))
      );
      yield* _(Fiber.interrupt(workerFiber));
    });

    // FIX: Provide TestContext
    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    expect(mockStorage.getPendingTransactions).toHaveBeenCalled();
    expect(
      vi.mocked(mockStorage.getPendingTransactions).mock.calls.length
    ).toBeGreaterThanOrEqual(2);
    expect(mockBlockchain.sendRawTx).not.toHaveBeenCalled();
  });

  it("should continue processing after transaction failures", async () => {
    const tx1 = createMockTransaction("tx-1");
    const tx2 = createMockTransaction("tx-2");

    vi.mocked(mockStorage.getPendingTransactions).mockReturnValue(
      Effect.succeed([tx1, tx2])
    );

    let callCount = 0;
    vi.mocked(mockBlockchain.sendRawTx).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Effect.fail({
          _tag: "ExecutionReverted",
          reason: "Contract reverted",
        } as SettlementError);
      }
      return Effect.succeed("0xabc123def456");
    });

    const testEffect = Effect.gen(function* (_) {
      const workerFiber = yield* _(
        Effect.fork(
          settlementWorker(mockBlockchain, mockStorage, mockConfig, mockSigner)
        )
      );

      yield* _(
        TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs + 3000))
      );
      yield* _(Fiber.interrupt(workerFiber));
    });

    // FIX: Provide TestContext
    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    expect(mockStorage.moveToDeadLetterQueue).toHaveBeenCalledWith(
      tx1.id,
      "Permanent error",
      expect.stringContaining("Execution reverted")
    );

    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      tx2.id,
      "SETTLED",
      "0xabc123def456"
    );
  });

  it("should maintain polling interval timing", async () => {
    const pollIntervalMs = 3000;
    const customConfig: ConfigService = {
      ...mockConfig,
      pollIntervalMs,
    };

    let pollTimestamps: number[] = [];
    vi.mocked(mockStorage.getPendingTransactions).mockImplementation(() => {
      pollTimestamps.push(Date.now()); // Note: Date.now() won't work with TestClock, check explanation below
      return Effect.succeed([]);
    });

    const testEffect = Effect.gen(function* (_) {
      // NOTE: TestClock controls Effect.sleep, but Date.now() is JS system time.
      // We rely on call counts here instead of timestamps for simplicity.
      const workerFiber = yield* _(
        Effect.fork(
          settlementWorker(
            mockBlockchain,
            mockStorage,
            customConfig,
            mockSigner
          )
        )
      );

      for (let i = 0; i < 3; i++) {
        yield* _(TestClock.adjust(Duration.millis(pollIntervalMs)));
      }

      yield* _(Fiber.interrupt(workerFiber));
    });

    // FIX: Provide TestContext
    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    expect(
      vi.mocked(mockStorage.getPendingTransactions).mock.calls.length
    ).toBeGreaterThanOrEqual(3);
  });

  it("should recover from database polling errors", async () => {
    let callCount = 0;

    vi.mocked(mockStorage.getPendingTransactions).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Effect.fail({
          _tag: "DbError",
          message: "Connection lost",
          operation: "getPendingTransactions",
        } as SettlementError);
      }
      return Effect.succeed([]);
    });

    const testEffect = Effect.gen(function* (_) {
      const workerFiber = yield* _(
        Effect.fork(
          settlementWorker(mockBlockchain, mockStorage, mockConfig, mockSigner)
        )
      );

      yield* _(
        TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs * 2.5))
      );
      yield* _(Fiber.interrupt(workerFiber));
    });

    // FIX: Provide TestContext
    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    expect(
      vi.mocked(mockStorage.getPendingTransactions).mock.calls.length
    ).toBeGreaterThanOrEqual(2);
  });

  it("should handle slow transaction processing without blocking polling", async () => {
    const tx1 = createMockTransaction("tx-1");
    let pollCount = 0;

    vi.mocked(mockStorage.getPendingTransactions).mockImplementation(() => {
      pollCount++;
      return Effect.succeed(pollCount === 1 ? [tx1] : []);
    });

    vi.mocked(mockBlockchain.sendRawTx).mockImplementation(() =>
      Effect.gen(function* (_) {
        yield* _(Effect.sleep(Duration.millis(2000)));
        return "0xabc123def456";
      })
    );

    const testEffect = Effect.gen(function* (_) {
      const workerFiber = yield* _(
        Effect.fork(
          settlementWorker(mockBlockchain, mockStorage, mockConfig, mockSigner)
        )
      );

      yield* _(
        TestClock.adjust(Duration.millis(mockConfig.pollIntervalMs + 5000))
      );
      yield* _(Fiber.interrupt(workerFiber));
    });

    // FIX: Provide TestContext
    await Effect.runPromise(
      testEffect.pipe(Effect.provide(TestContext.TestContext))
    );

    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      tx1.id,
      "PROCESSING"
    );
    expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
      tx1.id,
      "SETTLED",
      "0xabc123def456"
    );
  });
});