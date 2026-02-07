# Self-Healing Payment Settlement Engine: Effects Documentation

## Overview

This document describes the effect system architecture of the Self-Healing Payment Settlement Engine, a resilient blockchain transaction settlement system built with Effect-TS v3. It explains the I/O boundary (external interactions), the pure core (deterministic business logic), effect definitions (code references), and the runtime (execution model).

---

## 1. I/O Boundary (Effect Inventory)

The system observes and modifies the external world through the following effects:

### 1.1 Network Effects (RPC/Blockchain)
- **Nonce Retrieval**: Query current account nonce from Hardhat/RPC node
- **Gas Estimation**: Estimate transaction execution cost
- **Gas Price Querying**: Get current network gas price
- **Transaction Broadcasting**: Send signed transactions to the network
- **Transaction Receipt Polling**: Wait for and retrieve transaction confirmation receipts

### 1.2 Storage Effects (PostgreSQL Database)
- **Query Pending Transactions**: Fetch all transactions with `PENDING` status
- **Update Transaction Status**: Mutate transaction status (`PENDING` → `PROCESSING` → `SETTLED` / `FAILED`)
- **Increment Retry Count**: Track and persist transaction attempt history
- **Record Error Details**: Store error messages and diagnostic info
- **Dead-Letter Queue Operations**: Move exhausted transactions to DLQ table
- **Transaction Queries by Hash**: Retrieve transactions by on-chain hash

### 1.3 Time Effects
- **Polling Delays**: Adaptive wait intervals between DB polls (configurable via `POLL_INTERVAL_MS`)
- **Exponential Backoff Scheduling**: Automatic retry delays with increasing intervals and jitter
- **Timeout Constraints**: 60-second window for transaction confirmation per block

### 1.4 Concurrency Effects
- **Queue Operations**: Create bounded work queue, enqueue/dequeue transactions
- **Fiber Forking**: Spawn producer and multiple worker fibers for parallel processing
- **Supervisor Tracking**: Monitor fiber health and lifecycle
- **Atomic Reference Updates**: In-memory nonce Ref for thread-safe nonce tracking

### 1.5 Logging Effects
- **Structured Logging**: Emit timestamped, tagged logs via `Effect.log`
  - Examples: Producer polling events, worker processing status, error recovery actions

### 1.6 Configuration Effects
- **Environment Variable Loading**: Read `RPC_URL`, `PRIVATE_KEY`, `DATABASE_URL`, etc.
- **Configuration Validation**: Parse and validate using Zod schema

### 1.7 Resource Lifecycle Effects
- **Provider Initialization**: Create ethers.js RPC provider
- **Signer Creation**: Create ethers.js Wallet from private key
- **Database Connection Pool**: Establish and manage Postgres connections
- **Graceful Cleanup**: Release all resources on shutdown via finalizers

---

## 2. Effect Definitions (Code References)

### 2.1 Service Layer (Effect Providers)

#### **ConfigService**
*File*: [src/services/ConfigService.ts](src/services/ConfigService.ts)

- **Entrypoint**: `loadConfig()` - Effect that validates environment variables and returns typed `Config` object
- **Interface**: `ConfigService` - provides `rpcUrl`, `privateKey`, `databaseUrl`, `pollIntervalMs`, `maxRetries`, `maxGasPriceMultiplier`
- **Implementation**: Wraps Zod schema validation in `Effect.try` for structured error handling

#### **BlockchainService**
*File*: [src/services/BlockchainService.ts](src/services/BlockchainService.ts)

- **Interface**: Defines 6 effect-based methods:
  ```typescript
  - getNonce(address: string) → Effect<number, SettlementError>
  - estimateGas(tx: UnsignedTx) → Effect<bigint, SettlementError>
  - getGasPrice() → Effect<bigint, SettlementError>
  - sendRawTx(signedTx: string) → Effect<string, SettlementError>
  - getTxReceipt(hash: string) → Effect<TransactionResponse | null, SettlementError>
  - waitForTx(hash: string) → Effect<TransactionReceipt | null, SettlementError>
  ```
- **Implementation**: Each RPC call wrapped via `Effect.tryPromise`, errors mapped through `parseRpcError`

#### **StorageService**
*File*: [src/services/StorageService.ts](src/services/StorageService.ts)

- **Interface**: Defines 8 effect-based methods:
  ```typescript
  - getPendingTransactions() → Effect<Transaction[], SettlementError>
  - getTransactionsByStatus(status) → Effect<Transaction[], SettlementError>
  - getTransaction(id) → Effect<Transaction | undefined, SettlementError>
  - getTransactionByHash(hash) → Effect<Transaction | undefined, SettlementError>
  - updateTransactionStatus(id, status, hash?) → Effect<void, SettlementError>
  - incrementRetryCount(id) → Effect<void, SettlementError>
  - recordTransactionError(id, error) → Effect<void, SettlementError>
  - moveToDeadLetterQueue(txnId, reason, details?) → Effect<void, SettlementError>
  ```
- **Implementation**: All Drizzle queries wrapped in `Effect.try`, errors tagged as `DbError`

### 2.2 Error Definitions

*File*: [src/errors/index.ts](src/errors/index.ts)

- **Type**: `SettlementError` (discriminated union)
  ```
  | { _tag: "NonceToLow"; currentNonce; txNonce; address }
  | { _tag: "ReplacementFeeTooLow"; txHash; currentGasPrice; txGasPrice }
  | { _tag: "InsufficientFunds"; address; requiredBalance; actualBalance }
  | { _tag: "ExecutionReverted"; reason; data? }
  | { _tag: "NetworkError"; message; code? }
  | { _tag: "DbError"; message; operation }
  | { _tag: "ValidationError"; message; field }
  | { _tag: "Unknown"; underlying: Error }
  ```
- **Discriminators**:
  - `parseRpcError(error)` - Maps RPC errors to structured variants
  - `isTransient(error)` - Returns true for `NonceToLow`, `ReplacementFeeTooLow`, `NetworkError`
  - `isPermanent(error)` - Returns true for all others
  - `formatError(error)` - Human-readable error messages

### 2.3 Core Programs (Effect Composition)

#### **SettlementWorker**
*File*: [src/programs/SettlementWorker.ts](src/programs/SettlementWorker.ts)

- **Entrypoint**: `settlementWorker(blockchain, storage, config, signer) → Effect<never, SettlementError>`
- **Architecture**:
  - **Producer** fiber: Polls DB at `config.pollIntervalMs` intervals, enqueues PENDING transactions to bounded queue
  - **Worker** fibers (2 instances): Dequeue transactions, invoke `processTransaction`, handle errors
  - **Queue**: `Queue.bounded<WorkItem>(100)` for backpressure and decoupling
  - **Supervisor**: `Supervisor.track()` monitors all forked fibers
  - **Nonce Ref**: `Ref.make<number>(0)` maintains current account nonce in memory
- **Effect Stack**: Generators + `Effect.fork` + `Queue.take/offer` + `Effect.retry` + `Effect.catchAll`

#### **TransactionProcessor**
*File*: [src/programs/TransactionProcessor.ts](src/programs/TransactionProcessor.ts)

- **Entrypoint**: `processTransaction(txn, nonceRef, signer, blockchain, storage, config) → Effect<void, SettlementError>`
- **Flow**:
  1. Validate transaction parameters
  2. Fetch/update nonce from Ref (with chain fallback)
  3. Build unsigned transaction using stored parameters
  4. Sign transaction with signer
  5. Broadcast to network
  6. On success: update status → `SETTLED`, increment Ref nonce
  7. On transient error: record error, increment retry count, revert to `PENDING`
  8. On permanent error: move to dead-letter queue
- **Pure Branching**: Recovery path conditionally selected based on `isTransient()` discriminator

### 2.4 Database Schema

*File*: [src/db/schema.ts](src/db/schema.ts)

- **Tables**:
  - `transactions`: id (UUID), hash, status (enum), toAddress, value, calldata, gasLimit, retryCount, lastError, createdAt, updatedAt
  - `dead_letter_queue`: id, transactionId (FK), reason, errorDetails, enqueuedAt
- **Indexes**: On (status, updatedAt), (hash), (retryCount) for fast lookups

### 2.5 Utilities

*File*: [src/utils/gas.ts](src/utils/gas.ts)

- **Functions**:
  - `estimateGasWithBuffer(estimated, percent?)` - Adds safety margin to gas estimation
  - `calculateReplacementGasPrice(current, multiplier?)` - Bumps gas price for "Replacement fee too low" recovery
  - `buildUnsignedTx(params)` - Constructs UnsignedTx object from stored transaction data
  - `signTransaction(signer, unsignedTx)` - Wraps ethers signer in Effect
  - `validateTransaction(tx)` - Validates address formats, data integrity

### 2.6 Runtime Entry Point

*File*: [src/main.ts](src/main.ts)

- **Main Effect**: `main` - Uses `Effect.scoped` to ensure resource cleanup
- **Setup Steps** (in order):
  1. `loadConfig()` - Validate environment
  2. `initDb(...)` - Create database client with pool management
  3. Create ethers.js provider and signer
  4. Create service instances (ConfigService, BlockchainService, StorageService)
  5. Fork settlement worker
  6. Add finalizer for graceful shutdown logging
- **Execution**: `Effect.runPromise(main)` - Async runtime execution with error handling

---

## 3. Pure Core (Business Logic)

### 3.1 Data Flow

```
[External World]
       ↓
   [Config] → Environment variables (RPC URL, private key, DB URL)
       ↓
   [Database Queries] → "SELECT * FROM transactions WHERE status='PENDING'"
       ↓
   [Transaction Data] → to_address, value, calldata, retry_count
       ↓
   [Nonce Management] → In-memory Ref (fast) or chain query (fallback)
       ↓
   [Transaction Building] → Construct unsigned tx with nonce, gas price, chainId
       ↓
   [Signing] → Sign with private key
       ↓
   [RPC Broadcast] → Send via ethers.broadcastTransaction()
       ↓
   [Error Analysis] → parseRpcError() → isTransient() or isPermanent()
       ↓
   [Recovery Decision] → 
        if transient & retries < max:
          - Update Ref nonce (if nonce error)
          - Increment retry count
          - Revert status to PENDING
        if transient & retries >= max or permanent:
          - Insert to dead_letter_queue table
          - Mark status as FAILED
       ↓
   [Database Updates] → INSERT/UPDATE transactions and dead_letter_queue
       ↓
   [Logging] → Emit structured logs for monitoring
```

### 3.2 Key Invariants

1. **Single Nonce Stream**: In-memory Ref ensures monotonically increasing nonce per sender
2. **Transient vs Permanent**: Error discrimination prevents infinite retries on permanent failures
3. **Max Retries Bound**: Every transaction either settles or exhausts retries within `MAX_RETRIES` limit
4. **Atomicity**: DB updates (status + retry count) are atomic per transaction
5. **Safe Shutdown**: All finalizers execute before process exit, ensuring no resource leaks

### 3.3 Self-Healing Mechanisms

#### **Nonce Too Low Recovery**
- Trigger: RPC returns "nonce too low" error
- Detection: `parseRpcError()` extracts `currentNonce` from error message
- Action: Update Ref to `currentNonce`, rebuild and retry transaction
- Guarantee: Next attempt uses correct nonce, preventing immediate resubmission

#### **Replacement Fee Too Low Recovery**
- Trigger: RPC returns "replacement fee too low" for resubmitted tx
- Detection: `parseRpcError()` identifies `ReplacementFeeTooLow` variant
- Action: Call `calculateReplacementGasPrice()`, regenerate tx with bumped gas, retry
- Guarantee: Subsequent tx has higher gas price, preventing spam from replacement rules

#### **Network Transience Recovery**
- Trigger: ECONNREFUSED, ENOTFOUND, or generic network errors
- Detection: `isTransient()` returns true for `NetworkError`
- Action: Record error, increment retry, schedule exponential backoff via `Schedule.exponential`
- Guarantee: Automatic retry with increasing delays prevents thundering herd

#### **Permanent Error Routing**
- Trigger: Execution reverted, insufficient funds, invalid addresses
- Detection: `isPermanent()` logic recognizes `ExecutionReverted`, `InsufficientFunds`
- Action: Immediately move to dead-letter queue, mark as FAILED
- Guarantee: No wasted retries, issue visible for manual intervention

### 3.4 Execution Paths

**Happy Path** (Successful Settlement):
```
PENDING → validateTx → getNonce → buildTx → signTx → sendRawTx 
→ _success_ → updateStatus(SETTLED) → Ref.nonce++ → Loop back
```

**Transient Error Path** (Retryable):
```
... → sendRawTx → _Error: NonceToLow_ → parseError → isTransient=true 
→ retryCount < maxRetries → updateRef(newNonce) → incrementRetry 
→ updateStatus(PENDING) → RequeueToQueue → Loop back
```

**Permanent Error Path** (Non-Retryable):
```
... → sendRawTx → _Error: ExecutionReverted_ → parseError → isPermanent=true 
→ moveToDeadLetterQueue → updateStatus(FAILED) → Loop back
```

**Exhausted Retries Path**:
```
retryCount >= maxRetries && isTransient → moveToDeadLetterQueue → FAILED
```

---

## 4. Runtime (Effect-TS v3 Execution Model)

### 4.1 Stack

- **Language**: TypeScript ES2022
- **Effect Library**: Effect-TS v3.x
- **Blockchain Layer**: ethers.js v6.x (JSON-RPC provider + Signer)
- **Database**: Drizzle ORM + postgres-js driver
- **Scheduler**: Effect built-in Schedule module

### 4.2 Fiber Architecture

```
Main Effect.scoped
├── initDb() [acquireRelease]
├── provider creation [try]
├── signer creation [try]
└── settlementWorker() [gen + fork]
    ├── nonceRef = Ref.make(0)
    ├── workQueue = Queue.bounded(100)
    ├── supervisor = Supervisor.track()
    ├── Producer Fiber (fork)
    │   └── while(true): 
    │       - getPendingTxns()
    │       - Queue.offer(each)
    │       - sleep(pollInterval)
    └── Worker Fibers x2 (fork)
        └── while(true):
            - Queue.take()
            - processTransaction(retry schedule)
            - Effect.catchAll(log error, continue)
```

### 4.3 Generative Effects (Effect.gen)

All business logic uses generators for readability:

```typescript
const example = Effect.gen(function* (_) {
  const config = yield* _(loadConfig());          // unwrap Effect<Config>
  const db = yield* _(initDb(config.databaseUrl)); // unwrap Effect<Db>
  const pending = yield* _(storage.getPendingTransactions()); // unwrap Effect<Tx[]>
  
  // Synchronous logic
  const result = pending.filter(...);
  
  // Re-enter Effect monad
  yield* _(Effect.log(`Processed ${result.length} transactions`));
  
  return result;
});
```

### 4.4 Error Handling Strategy

- **Discriminated Unions**: `SettlementError` variants allow pattern matching in `Effect.catchTags` or manual checks
- **Try-Catch Mapping**: `Effect.try` + `Effect.tryPromise` convert JS errors to structured types
- **Conditional Recovery**: Errors trigger different paths based on `isTransient()` check
- **Logging on Error**: All errors logged before recovery attempts
- **Fiber Isolation**: Worker errors caught via `Effect.catchAll` to prevent fiber termination

### 4.5 Resource Cleanup (Scope)

```typescript
Effect.scoped(
  Effect.gen(function* (_) {
    const _scope = yield* _(Scope.current());
    
    // Register finalizer (cleanup on exit)
    yield* _(Scope.addFinalizer(_scope, 
      Effect.log("Shutting down gracefully...")
    ));
    
    // All acquireRelease resources auto-finalized
    const db = yield* _(initDb(...)); // auto-cleanup on exit
    
    // Long-running effect (keeper doesn't return)
    yield* _(settlementWorker(...));
  })
)
```

On process exit or error:
1. Settlement worker fibers interrupted
2. Producer/worker loops exit
3. Finalizers execute (in reverse order of registration)
4. DB connection pool closed
5. Process terminates cleanly

### 4.6 Execution Entry Point

```typescript
// src/main.ts
Effect.runPromise(main).catch((error) => {
  console.error("[App] Fatal error:", error);
  process.exit(1);
});
```

- **runPromise**: Executes Effect in Node.js using async/await, returns Promise
- **Error Handler**: Catches unhandled top-level errors and exits
- **Never Returns**: Settlement worker uses `Effect.never`, so the Promise resolves only on error/interrupt

### 4.7 Scheduling & Backoff

```typescript
// Producer: adaptive polling
Effect.sleep(Duration.millis(config.pollIntervalMs))

// Worker: exponential backoff on transient error
Effect.retry(
  Schedule.exponential(Duration.millis(100)).pipe(
    Schedule.maxRetries(2)
  )
)
// Results in delays: 0ms → 100ms → 200ms (attempts: 1st, 2nd+retry, 3rd+retry)
```

---

## 5. Summary Table

| Aspect | Implementation |
|--------|---|
| **I/O Boundary** | Network (ethers RPC), Storage (Postgres via Drizzle), Time (sleep/schedule), Concurrency (Queue/fibers), Logging |
| **Effect Inventory** | 6 × BlockchainService methods, 8 × StorageService methods, loadConfig, initDb, and derived types/helpers |
| **Error Model** | Discriminated union `SettlementError` with 8 variants; `isTransient()`/`isPermanent()` for routing |
| **Pure Logic** | TX validation → nonce mgmt → sign → broadcast → error check → retry or DLQ routing |
| **Self-Healing** | Nonce tracking (Ref + chain query), gas bumping, transient retry with backoff, permanent error quarantine |
| **Runtime** | Effect-TS v3 + ethers.js v6 + Drizzle ORM on Node.js ES2022 |
| **Lifecycle** | `Effect.scoped` + `acquireRelease` + finalizers ensure resource cleanup |
| **Concurrency** | 2 worker fibers + 1 producer fiber, Queue-based work distribution, Supervisor monitoring |

---

## 6. Key Takeaways

1. **Pure Effects**: Every side effect (RPC, DB, time, log) is explicitly modeled as an Effect type, making the system testable and composable.
2. **Discriminated Errors**: Structured error types enable intelligent recovery—transient errors retry with backoff, permanent errors quarantine to DLQ.
3. **Ref-Based Nonce**: In-memory Ref provides fast nonce tracking; chain query fallback ensures crash safety.
4. **Producer-Consumer**: Work Queue decouples polling from processing, enabling adaptive backpressure and parallel work distribution.
5. **Supervisor & Fibers**: Multiple worker fibers under supervisor ensure safe concurrent processing with coordinated lifecycle.
6. **Scope Cleanup**: `Effect.scoped` + finalizers guarantee resource release on process exit, preventing connection leaks.

This architecture delivers a resilient, self-healing payment settlement engine that gracefully handles transient errors while quarantining permanent failures for human review.
