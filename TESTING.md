# Test Suite Documentation

## Overview

This document describes the comprehensive test suites for the **Self-Healing Payment Settlement Engine**. The test suite consists of two main test files:

1. **TransactionProcessor.test.ts** - Unit tests for transaction processing logic
2. **SettlementWorker.test.ts** - Integration/simulation tests for the worker polling and retry logic

Both test suites are built with **Vitest** and **Effect-TS v3**, leveraging Effect's powerful testing utilities like `TestClock` for time manipulation.

---

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

This will install all development dependencies including:
- `vitest` - The test runner
- `@vitest/coverage-v8` - Coverage reporting
- All Effect-TS and blockchain libraries

### 2. Run Tests

```bash
# Run tests in watch mode (recommended for development)
npm test

# Run tests once (CI mode)
npm run test:run

# Run tests with coverage report
npm run test:coverage
```

---

## TransactionProcessor.test.ts

### Purpose
Unit tests for the `processTransaction` function, which handles the core settlement logic: signing, sending, and error recovery.

### Test Cases

#### Test Case 1: Happy Path
**File:** [src/programs/TransactionProcessor.test.ts](src/programs/TransactionProcessor.test.ts#L120)

Verifies that a transaction is processed successfully:
- ✅ Transaction status is updated to "PROCESSING"
- ✅ Transaction is signed and sent to blockchain
- ✅ Transaction status is updated to "SETTLED" with tx hash
- ✅ Nonce reference is incremented
- ✅ No errors occur

**Mock Setup:**
```typescript
vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
  Effect.succeed(finalTxHash)
);
```

#### Test Case 2: Transient Error - Nonce Too Low
**File:** [src/programs/TransactionProcessor.test.ts](src/programs/TransactionProcessor.test.ts#L165)

Verifies that transient `NonceToLow` errors are handled with retry logic:
- ✅ Error is caught and processed
- ✅ `incrementRetryCount` is called
- ✅ Transaction status is set back to "PENDING"
- ✅ Nonce reference is updated to the correct value from the error
- ✅ Error is recorded in storage

**Mock Setup:**
```typescript
const nonceToLowError: SettlementError = {
  _tag: "NonceToLow",
  currentNonce: 7,
  txNonce: 5,
  address: "0x...",
};
vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
  Effect.fail(nonceToLowError)
);
```

#### Test Case 3: Permanent Error - Execution Reverted
**File:** [src/programs/TransactionProcessor.test.ts](src/programs/TransactionProcessor.test.ts#L217)

Verifies that permanent `ExecutionReverted` errors move to dead letter queue:
- ✅ Error is caught and processed
- ✅ `moveToDeadLetterQueue` is called
- ✅ Transaction status is NOT set to "PENDING" (no retry)
- ✅ `incrementRetryCount` is NOT called
- ✅ Error is recorded in storage

**Key Assertion:**
```typescript
expect(mockStorage.moveToDeadLetterQueue).toHaveBeenCalledWith(
  txn.id,
  "Permanent error",
  expect.stringContaining("Execution reverted")
);
```

#### Test Case 4: Max Retries Exceeded
**File:** [src/programs/TransactionProcessor.test.ts](src/programs/TransactionProcessor.test.ts#L260)

Verifies that transactions exceeding max retries are moved to DLQ:
- ✅ After `maxRetries` attempts, transaction is moved to DLQ even for transient errors
- ✅ `moveToDeadLetterQueue` is called with retry count in message

#### Test Case 5: ReplacementFeeTooLow (Transient)
**File:** [src/programs/TransactionProcessor.test.ts](src/programs/TransactionProcessor.test.ts#L295)

Verifies that `ReplacementFeeTooLow` is treated as transient:
- ✅ Retry count is incremented
- ✅ Status is set to "PENDING"
- ✅ Transaction can be retried

#### Test Case 6: InsufficientFunds (Permanent)
**File:** [src/programs/TransactionProcessor.test.ts](src/programs/TransactionProcessor.test.ts#L326)

Verifies that `InsufficientFunds` is treated as permanent:
- ✅ Moved to DLQ immediately
- ✅ Retry count is NOT incremented

#### Test Case 7: Nonce Initialization
**File:** [src/programs/TransactionProcessor.test.ts](src/programs/TransactionProcessor.test.ts#L353)

Verifies that nonce is initialized from chain when uninitialized:
- ✅ When `nonceRef` is `-1`, `blockchain.getNonce()` is called
- ✅ Nonce is fetched and incremented after successful transaction

### Mocking Strategy

The tests use **functional mocks** (objects with Effect-returning methods) instead of class-based mocks:

```typescript
const mockBlockchain: BlockchainService = {
  getNonce: vi.fn(() => Effect.succeed(5)),
  sendRawTx: vi.fn(() => Effect.succeed("0x...")),
  // ... etc
};
```

This approach:
- Aligns with Effect-TS principles (functions over classes)
- Enables easy return value configuration via `Effect.succeed` or `Effect.fail`
- Allows `vi.fn()` for call verification

---

## SettlementWorker.test.ts

### Purpose
Integration/simulation tests for the `settlementWorker`, which orchestrates polling, concurrent processing, and retry schedules. These tests use **TestClock** to manipulate time and verify correct scheduling behavior.

### Key Concepts

#### TestClock
All tests are wrapped in `Effect.runPromise(effect.pipe(TestClock.make))`, which:
- Replaces real time with a virtual clock
- Allows `TestClock.advance(duration)` to fast-forward time
- Ensures deterministic test execution (no flaky timing issues)

**Example:**
```typescript
const testEffect = Effect.gen(function* (_) {
  const workerFiber = yield* _(Effect.fork(settlementWorker(...)));
  
  // Simulate 15 seconds of wall-clock time
  yield* _(TestClock.adjust(Duration.millis(15000)));
  
  yield* _(Fiber.interrupt(workerFiber));
});

await Effect.runPromise(testEffect.pipe(TestClock.make));
```

#### Fiber Management
Tests use `Effect.fork` to spawn the worker in a background fiber and `Fiber.interrupt` to clean up:

```typescript
const workerFiber = yield* _(Effect.fork(
  settlementWorker(blockchain, storage, config, signer)
));

// ... verify behavior ...

yield* _(Fiber.interrupt(workerFiber));
```

### Test Cases

#### Test Case 1: Polling at Intervals
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L121)

Verifies that the worker polls the database at configured intervals:
- ✅ `getPendingTransactions` is called multiple times
- ✅ First polls return empty, then a transaction after a few cycles
- ✅ Demonstrates the producer polling loop

**Key Pattern:**
```typescript
let pollCount = 0;
vi.mocked(mockStorage.getPendingTransactions).mockImplementation(() => {
  pollCount++;
  return Effect.succeed(pollCount >= 3 ? [tx1] : []);
});

// Advance time by poll intervals
yield* _(TestClock.adjust(Duration.millis(config.pollIntervalMs * 1.5)));
```

#### Test Case 2: Transaction Processing
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L161)

Verifies that pending transactions are picked up and processed:
- ✅ Transaction enters queue and is picked up by a worker fiber
- ✅ Status is updated to "PROCESSING" then "SETTLED"
- ✅ TX hash is recorded with the settlement

#### Test Case 3: Exponential Backoff on Transient Errors
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L200)

Verifies that retry schedules work correctly (exponential backoff):
- ✅ First attempt fails with `NetworkError`
- ✅ Worker applies retry schedule: `Schedule.exponential(100ms)`
- ✅ Subsequent retries succeed
- ✅ Error is recorded

**Mock Pattern:**
```typescript
let attemptCount = 0;
vi.mocked(mockBlockchain.sendRawTx).mockImplementation(() => {
  attemptCount++;
  if (attemptCount === 1) {
    return Effect.fail({ _tag: "NetworkError", ... });
  }
  return Effect.succeed("0x...");
});

// Advance time for exponential backoff
yield* _(TestClock.adjust(Duration.millis(500)));
```

#### Test Case 4: Concurrent Worker Pool
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L251)

Verifies that multiple worker fibers process transactions concurrently:
- ✅ Multiple pending transactions are returned from storage
- ✅ Both workers pick up work from the queue
- ✅ All transactions are processed without blocking each other

#### Test Case 5: Duplicate Prevention
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L298)

Verifies that `activeTxIds` set prevents duplicate processing:
- ✅ Same transaction returned on multiple polls
- ✅ Only processed once despite multiple returns
- ✅ Demonstrates in-flight deduplication

#### Test Case 6: Idle State
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L343)

Verifies graceful handling of no pending transactions:
- ✅ `getPendingTransactions` is called but returns empty array
- ✅ Worker doesn't crash, continues polling
- ✅ No transactions sent when queue is empty

#### Test Case 7: Mixed Success/Failure in Batch
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L378)

Verifies that the worker continues after transaction failures:
- ✅ TX1 fails (moved to DLQ), TX2 succeeds (settled)
- ✅ Worker doesn't crash on first failure
- ✅ Demonstrates resilient batch processing

#### Test Case 8: Polling Interval Timing
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L428)

Verifies exact timing of polling intervals:
- ✅ Custom poll interval is respected
- ✅ `TestClock` ensures deterministic timing
- ✅ No race conditions

#### Test Case 9: Error Recovery in Producer
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L471)

Verifies that the producer fiber recovers from database errors:
- ✅ First polling call fails with `DbError`
- ✅ Worker doesn't crash
- ✅ Subsequent polls succeed
- ✅ Demonstrates self-healing behavior

#### Test Case 10: Long-running Transaction
**File:** [src/programs/SettlementWorker.test.ts](src/programs/SettlementWorker.test.ts#L515)

Verifies that slow transactions don't block polling:
- ✅ `sendRawTx` includes `Effect.sleep(2000)`
- ✅ Polling continues in parallel via concurrent workers
- ✅ Worker doesn't block on slow blockchain operations

---

## Test Execution Flow

### TransactionProcessor Tests

```
Start TransactionProcessor test
  ├─ Setup: Create mocks for all services
  ├─ Run: Effect.runPromise(processTransaction(...))
  ├─ Verify: Check mock calls and side effects
  └─ End: Move to next test
```

### SettlementWorker Tests

```
Start SettlementWorker test
  ├─ Setup: Create mocks for all services
  ├─ Wrap in TestClock: Effect.runPromise(testEffect.pipe(TestClock.make))
  ├─ Fork worker: Effect.fork(settlementWorker(...))
  ├─ Advance time: TestClock.adjust(duration)
  ├─ Verify: Check mock calls
  ├─ Cleanup: Fiber.interrupt(workerFiber)
  └─ End: Move to next test
```

---

## Error Handling

Both test suites verify proper error handling:

### Transient Errors (Retried)
- `NonceToLow` - Nonce conflict on chain
- `ReplacementFeeTooLow` - Gas price too low
- `NetworkError` - Temporary network issues

**Expected Behavior:** Retry with exponential backoff until max retries, then move to DLQ.

### Permanent Errors (Not Retried)
- `ExecutionReverted` - Transaction reverted by contract
- `InsufficientFunds` - Account has insufficient balance
- `ValidationError` - Invalid transaction parameters

**Expected Behavior:** Immediately move to DLQ.

---

## Mocking Best Practices Used

### 1. Effect-based Mocks
```typescript
const mockBlockchain: BlockchainService = {
  sendRawTx: vi.fn(() => Effect.succeed("0x...")),
};
```

### 2. Spy on Effect Calls
```typescript
expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
  txn.id,
  "SETTLED",
  txHash
);
```

### 3. Control Mock Behavior with Implementation
```typescript
vi.mocked(mockBlockchain.sendRawTx).mockImplementation(() => {
  attemptCount++;
  if (attemptCount === 1) {
    return Effect.fail(error);
  }
  return Effect.succeed("0x...");
});
```

### 4. Use TestClock for Deterministic Timing
```typescript
yield* _(TestClock.adjust(Duration.millis(5000)));
```

---

## Debugging Tests

### Run Single Test
```bash
npm test -- /src/programs/TransactionProcessor.test.ts
```

### Run Specific Test Case
```bash
npm test -- TransactionProcessor -t "Happy Path"
```

### Debug with Console Logs
```typescript
yield* _(Effect.log("Message")); // Logs to console via Effect
```

### Check Mock Calls
```typescript
console.log(mockStorage.updateTransactionStatus.mock.calls);
```

---

## Coverage Goals

The test suite aims for:
- **Unit coverage:** 90%+ for TransactionProcessor.ts
- **Integration coverage:** 85%+ for SettlementWorker.ts
- **Path coverage:** All error handling paths (happy path, transient, permanent)

Run coverage report with:
```bash
npm run test:coverage
```

---

## Common Pitfalls & Solutions

### Pitfall 1: Flaky Tests Due to Timing
**Solution:** Always use `TestClock` instead of `setTimeout` or real delays.

### Pitfall 2: Mock Not Being Used
**Solution:** Ensure mocks are passed to the functions, e.g., `processTransaction(txn, nonceRef, mockSigner, **mockBlockchain**, mockStorage, mockConfig)`

### Pitfall 3: Effect Not Being Awaited
**Solution:** Always use `await Effect.runPromise(effect)` to run effects.

### Pitfall 4: Fiber Not Being Cleaned Up
**Solution:** Always call `Fiber.interrupt(workerFiber)` after tests complete.

### Pitfall 5: Forgetting TestClock.make
**Solution:** Always pipe test effect: `await Effect.runPromise(testEffect.pipe(TestClock.make))`

---

## Integration with CI/CD

Add to your GitHub Actions or CI pipeline:

```yaml
- name: Run Tests
  run: npm run test:run

- name: Generate Coverage
  run: npm run test:coverage

- name: Upload Coverage
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/coverage-final.json
```

---

## Further Reading

- [Effect-TS Testing Guide](https://effect.website/docs/testing)
- [TestClock Documentation](https://effect.website/docs/reference/testing/testclock)
- [Vitest Documentation](https://vitest.dev/)
- [ethers.js v6 Guide](https://docs.ethers.org/v6/)

---

## Support

For issues or questions about the test suite:
1. Check this documentation
2. Review specific test case comments in the .test.ts files
3. Run tests in debug mode: `npm test -- --inspect-brk`
