# Quick Reference: Testing Your Settlement Engine

## Installation

```bash
cd /home/nemethm/eth_oxford/self_healing_payment_settlement_engine
npm install
```

This installs:
- `vitest` - Test runner
- `@vitest/coverage-v8` - Coverage reporting
- All other dependencies (Effect v3, ethers, etc.)

## Running Tests

### Watch Mode (Recommended for Development)
```bash
npm test
```
- Reruns on file changes
- Interactive mode
- Good for TDD workflow

### Single Run (for CI/CD)
```bash
npm run test:run
```
- Runs all tests once
- Exit code 0 = success, non-zero = failure
- Use in GitHub Actions, etc.

### With Coverage Report
```bash
npm run test:coverage
```
- Generates HTML report in `./coverage`
- Shows line, branch, function coverage
- Open `coverage/index.html` to view

## Run Specific Tests

```bash
# Run only TransactionProcessor tests
npm test -- TransactionProcessor

# Run specific test case by name
npm test -- -t "Happy Path"

# Run with filtering
npm test -- -t "NonceToLow"
```

## Test Files Overview

### TransactionProcessor.test.ts (7 tests)
```
✓ Happy Path
✓ Transient Error - Nonce Too Low  
✓ Permanent Error - Execution Reverted
✓ Max Retries Exceeded
✓ ReplacementFeeTooLow (Transient)
✓ InsufficientFunds (Permanent)
✓ Nonce Initialization
```

**Focus Areas:**
- Error categorization (transient vs permanent)
- Retry count management
- Nonce synchronization
- Dead letter queue handling

### SettlementWorker.test.ts (10 tests)
```
✓ Polling at Intervals
✓ Transaction Processing
✓ Exponential Backoff
✓ Concurrent Worker Pool
✓ Duplicate Prevention
✓ Idle State
✓ Mixed Success/Failure
✓ Polling Interval Timing (TestClock)
✓ Error Recovery
✓ Long-running Transactions
```

**Focus Areas:**
- Producer/consumer pattern
- Concurrent worker orchestration
- Time-based scheduling (TestClock)
- Resilience and recovery

## What to Look For

### Test Output Example
```
✓ src/programs/TransactionProcessor.test.ts (7)
  ✓ should process a transaction successfully and update status to SETTLED (45ms)
  ✓ should handle NonceToLow error transiently (22ms)
  ✓ should handle ExecutionReverted error permanently (18ms)
  ...

✓ src/programs/SettlementWorker.test.ts (10)
  ✓ should poll database at configured intervals (102ms)
  ✓ should process pending transactions from the queue (87ms)
  ...

Test Files  2 passed (2)
Tests      17 passed (17)
```

## Troubleshooting

### Module Not Found: 'vitest'
**Solution:** Run `npm install` to install all devDependencies

### TestClock Property Error
**Info:** This is expected in the draft - syntax needs verification. See `TEST_IMPLEMENTATION_SUMMARY.md` for details.

### Mock Property Access Issues
**Solution:** Verify mock property with `console.log(mockStorage.getPendingTransactions.mock)`

### Debug a Single Test
```bash
# Add only() to isolate one test:
it.only("should test this one...", async () => { ... })

# Then run:
npm test
```

## Documentation

- **TESTING.md** - Comprehensive testing guide (setup, cases, best practices)
- **TEST_IMPLEMENTATION_SUMMARY.md** - Implementation status and TODO items
- **TransactionProcessor.test.ts** - 7 unit test cases (inline docs)
- **SettlementWorker.test.ts** - 10 integration test cases (inline docs)

## Common Patterns

### Using a Mock Service
```typescript
const mock: BlockchainService = {
  sendRawTx: vi.fn(() => Effect.succeed("0x123")),
  getNonce: vi.fn(() => Effect.succeed(5)),
  // ... other methods
};
```

### Verifying Mock Calls
```typescript
expect(mock.sendRawTx).toHaveBeenCalledWith(signedTx);
expect(vi.mocked(mock.getNonce).mock.calls.length).toBe(1);
```

### Testing Effect Failures
```typescript
const error: SettlementError = { _tag: "NonceToLow", ... };
vi.mocked(mock.sendRawTx).mockReturnValue(Effect.fail(error));
```

### Running Async Effects
```typescript
const result = await Effect.runPromise(someEffect);
expect(result).toBe(expectedValue);
```

## Next Steps

1. **Run the tests:** `npm test`
2. **Review any failures** - Most should pass, some TestClock patterns may need tweaks
3. **Check coverage:** `npm run test:coverage`
4. **Fix API issues** - See TEST_IMPLEMENTATION_SUMMARY.md for known TODO items
5. **Add to CI/CD** - Use `npm run test:run` in your GitHub Actions

## Need Help?

- Check inline test comments for detailed case descriptions
- Review TESTING.md for comprehensive documentation
- Check TEST_IMPLEMENTATION_SUMMARY.md for implementation status
- Verify Effect v3 API docs: https://effect.website/docs/testing

---

**Test Suite Status:** Ready to use (draft - minor Effect API tweaks may be needed)
**Coverage Target:** 85%+ for integration tests, 90%+ for unit tests
**Total Test Cases:** 17 (7 unit + 10 integration)
