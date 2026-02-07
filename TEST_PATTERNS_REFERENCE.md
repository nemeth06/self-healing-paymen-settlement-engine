# Test Implementation Patterns & Examples

## 1. Functional Mock Services

### Pattern
```typescript
const mockBlockchain: BlockchainService = {
  sendRawTx: vi.fn(() => Effect.succeed("0x123456")),
  getNonce: vi.fn(() => Effect.succeed(5)),
  getGasPrice: vi.fn(() => Effect.succeed(BigInt(20000000000))),
  // ... other methods
};
```

### Benefits
- Follows Effect-TS functional paradigm (no classes)
- Easy to spy on with `vi.fn()`
- Returns proper Effect types
- Easy to mock errors: `Effect.fail(error)`

## 2. Error Handling Pattern: Transient vs Permanent

### Transient Error (Retry)
```typescript
it("should retry on transient error", async () => {
  const error: SettlementError = {
    _tag: "NonceToLow",
    currentNonce: 7,
    txNonce: 5,
    address: "0x...",
  };

  vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
    Effect.fail(error)
  );

  await Effect.runPromise(
    processTransaction(txn, nonceRef, signer, blockchain, storage, config)
  );

  // Verify retry logic was triggered
  expect(mockStorage.incrementRetryCount).toHaveBeenCalledWith(txn.id);
  expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
    txn.id,
    "PENDING"
  );
});
```

### Permanent Error (No Retry)
```typescript
it("should not retry on permanent error", async () => {
  const error: SettlementError = {
    _tag: "ExecutionReverted",
    reason: "Contract reverted",
  };

  vi.mocked(mockBlockchain.sendRawTx).mockReturnValue(
    Effect.fail(error)
  );

  await Effect.runPromise(
    processTransaction(txn, nonceRef, signer, blockchain, storage, config)
  );

  // Verify moved to DLQ (not retried)
  expect(mockStorage.moveToDeadLetterQueue).toHaveBeenCalledWith(
    txn.id,
    "Permanent error",
    expect.stringContaining("Execution reverted")
  );
  expect(mockStorage.incrementRetryCount).not.toHaveBeenCalled();
});
```

## 3. Ref-Based Mutable State

### Pattern
```typescript
let nonceRef: Ref.Ref<number>;

beforeEach(async () => {
  // Initialize a mutable reference
  nonceRef = await Effect.runPromise(Ref.make<number>(5));
});

it("should increment nonce", async () => {
  // Run effect that modifies nonce
  await Effect.runPromise(
    processTransaction(txn, nonceRef, signer, blockchain, storage, config)
  );

  // Verify nonce was incremented
  const finalNonce = await Effect.runPromise(Ref.get(nonceRef));
  expect(finalNonce).toBe(6);
});
```

### Key Points
- `Ref.make()` returns an Effect that must be awaited
- `Ref.get()` reads the current value
- `Ref.set()` modifies the value
- Perfect for tracking nonce across transaction attempts

## 4. Conditional Mock Behavior

### Pattern: Return Different Values on Repeat Calls
```typescript
let callCount = 0;

vi.mocked(mockBlockchain.sendRawTx).mockImplementation(() => {
  callCount++;
  if (callCount === 1) {
    // First call fails
    return Effect.fail({ _tag: "NetworkError", ... });
  }
  // Subsequent calls succeed
  return Effect.succeed("0xabc123");
});

await Effect.runPromise(processTransaction(...));

// Both attempts were made
expect(mockBlockchain.sendRawTx).toHaveBeenCalledTimes(2);
```

## 5. TestClock Pattern (Effect v3)

### Pattern (Draft - needs verification)
```typescript
const testEffect = Effect.gen(function* (_) {
  // Fork worker in background
  const workerFiber = yield* _(Effect.fork(
    settlementWorker(blockchain, storage, config, signer)
  ));

  // Advance virtual time
  yield* _(TestClock.adjust(Duration.millis(5000)));

  // More time advancement
  yield* _(TestClock.adjust(Duration.millis(2000)));

  // Cleanup
  yield* _(Fiber.interrupt(workerFiber));
});

// TODO: Verify this pattern works with your Effect version
const runtime = Layer.toRuntime(TestClock.live);
await Effect.runPromise(testEffect, runtime);
```

### What's Happening
1. `Effect.gen` - Generator-based Effect composition
2. `Effect.fork` - Spawn worker in background fiber  
3. `TestClock.adjust` - Move virtual time forward (no actual waiting)
4. `Fiber.interrupt` - Cleanup the background fiber
5. `Layer.toRuntime` - Convert TestClock layer to runtime
6. `Effect.runPromise(effect, runtime)` - Run with test clock

### Advantages
- Tests timing without actual delays (fast!)
- Deterministic - no flaky timing issues
- Skip 10 seconds of virtual time in milliseconds of real time

## 6. Mock Call Verification

### Pattern
```typescript
// Simple verification
expect(mockService.method).toHaveBeenCalled();
expect(mockService.method).toHaveBeenCalledWith(expectedArg);

// Advanced verification
const mockFn = vi.mocked(mockService.method);
expect(mockFn.mock.calls.length).toBe(3);
expect(mockFn.mock.calls[0][0]).toBe("first call arg");

// Check specific call sequence
const calls = vi.mocked(mockService.method).mock.calls;
expect(calls[0][0]).toBe("first");
expect(calls[1][0]).toBe("second");
expect(calls[2][0]).toBe("third");
```

## 7. Complex Query Verification

### Pattern: Storage Query with Filtering
```typescript
it("should handle mix of success and failure", async () => {
  const tx1 = createMockTransaction("tx-1");
  const tx2 = createMockTransaction("tx-2");

  let callCount = 0;
  vi.mocked(mockStorage.getPendingTransactions).mockImplementation(() => {
    callCount++;
    // Return transactions only on first call
    return Effect.succeed(callCount === 1 ? [tx1, tx2] : []);
  });

  // Process with mixed results
  let tx1Calls = 0;
  vi.mocked(mockBlockchain.sendRawTx).mockImplementation(() => {
    tx1Calls++;
    if (tx1Calls === 1) {
      // tx1 fails
      return Effect.fail({ _tag: "ExecutionReverted", ... });
    }
    // tx2 succeeds
    return Effect.succeed("0x...");
  });

  // Run worker...

  // Verify: tx1 to DLQ, tx2 settled
  expect(mockStorage.moveToDeadLetterQueue).toHaveBeenCalledWith(
    tx1.id,
    "Permanent error",
    expect.anything()
  );
  expect(mockStorage.updateTransactionStatus).toHaveBeenCalledWith(
    tx2.id,
    "SETTLED",
    expect.anything()
  );
});
```

## 8. Transaction Creation Helper

### Pattern
```typescript
const createMockTransaction = (id: string, overrides?: Partial<Transaction>): Transaction => ({
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
  ...overrides,  // Override defaults for specific test
});

// Usage
const tx1 = createMockTransaction("tx-1");
const tx2 = createMockTransaction("tx-2", { retryCount: 2, status: "PROCESSING" });
```

## 9. Signer Mock

### Pattern
```typescript
const createMockSigner = (): ethers.Signer => ({
  getAddress: vi.fn(async () => "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"),
  signTransaction: vi.fn(),
  signMessage: vi.fn(),
  // ... other methods as needed
  _isSigner: true,
} as any);
```

## 10. Config Mock

### Pattern
```typescript
const mockConfig: ConfigService = {
  rpcUrl: "http://localhost:8545",
  rpcId: 31337,
  privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
  databaseUrl: "postgresql://localhost/test",
  pollIntervalMs: 2000,
  maxRetries: 3,
  maxGasPriceMultiplier: 2.0,
};
```

## Error Type Reference

### All Error Tags
```typescript
type SettlementError =
  | { _tag: "NonceToLow"; currentNonce: number; txNonce: number; address: string }
  | { _tag: "ReplacementFeeTooLow"; txHash: string; currentGasPrice: bigint; txGasPrice: bigint }
  | { _tag: "InsufficientFunds"; address: string; requiredBalance: string; actualBalance: string }
  | { _tag: "ExecutionReverted"; reason: string; data?: string }
  | { _tag: "NetworkError"; message: string; code?: string }
  | { _tag: "DbError"; message: string; operation: string }
  | { _tag: "ValidationError"; message: string; field: string }
  | { _tag: "Unknown"; underlying: Error };
```

## Key Takeaways

1. **Functional mocking** - Services are objects with Effect-returning methods
2. **Error discrimination** - Use `_tag` to route handling logic
3. **Ref for state** - Track mutable state like nonce cleanly
4. **TestClock for time** - No real delays, fully deterministic
5. **Spying on mocks** - `vi.mocked()` gives access to call details
6. **Generator-based Effects** - Use `Effect.gen` for composition
7. **Fiber management** - Fork/interrupt for concurrent patterns

---

**All patterns used in the test suite above. Refer to actual test files for complete examples.**
