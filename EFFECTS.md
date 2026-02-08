# Self-Healing Payment Settlement Engine – Effects Documentation

## Overview

The system is built using **Effect TS** and follows a clear separation between:

* Pure decision logic
* Typed effect boundaries
* A supervised concurrent runtime


## 1. I/O Boundary (Effect Inventory)

The system interacts with the outside world through the following categories of effects.

### 1.1 Blockchain Network (JSON-RPC via ethers)

Capabilities:

* Fetch account nonce
* Fetch current gas price
* Broadcast signed transactions
* Retrieve network information at startup

Defined in:

* `services/BlockchainService.ts`
* Used by `TransactionProcessor.ts` and `main.ts`

External dependency:

* Ethereum-compatible RPC endpoint

### 1.2 Persistent Storage (Database)

Capabilities:

* Fetch transactions with `PENDING` status
* Update transaction status
* Record error details
* Increment retry count
* Move transactions to Dead Letter Queue (DLQ)

Defined in:

* `services/StorageService.ts`

Used by:

* Producer (polling)
* Transaction processing and recovery logic


### 1.3 Configuration / Environment

Capabilities:

* Load environment variables
* Provide validated runtime configuration (RPC URL, DB URL, retry limits, polling interval, chain ID)

Defined in:

* `loadConfig()`
* `ConfigService`

External source:

* `.env` / process environment


### 1.4 Cryptography / Signing

Capabilities:

* Retrieve signer address
* Sign transactions

Defined via:

* `ethers.Wallet`
* `signTransaction()` in `utils/gas.ts`

External dependency:

* Private key

### 1.5 Time and Scheduling

Capabilities:

* Periodic database polling
* Exponential retry delays for transient failures

Defined via:

* `Effect.sleep`
* `Schedule.exponential`
* `Duration`


### 1.6 Concurrency and Coordination

Capabilities:

* Producer and worker fibers
* Bounded work queue
* Shared mutable state via `Ref`
* Fiber supervision

Defined via:

* `Queue`
* `Ref`
* `Effect.fork`
* `Supervisor`


### 1.7 Logging and Observability

Capabilities:

* Structured operational logs
* Error reporting
* Heartbeat and lifecycle logging

Defined via:

* `Effect.log`
* `Effect.logWarning`
* `Effect.logError`

### 1.8 Resource Lifecycle

Capabilities:

* Database initialization
* Provider and signer creation
* Graceful shutdown

Defined via:

* `Effect.scoped`
* `Scope.addFinalizer`
* `Effect.runPromise`

## 2. Effect Definitions (Code References)

### Core Services

**BlockchainService**
in `services/BlockchainService.ts`

* `getNonce(address)`
* `getGasPrice()`
* `sendRawTx(signedTx)`

**StorageService**
in `services/StorageService.ts`

* `getPendingTransactions()`
* `updateTransactionStatus()`
* `recordTransactionError()`
* `incrementRetryCount()`
* `moveToDeadLetterQueue()`

**ConfigService**
in `services/ConfigService.ts`

Provides validated runtime configuration.


### Error Algebra 
In `errors/index.ts`

Type:

```
SettlementError
```

Utilities:

* `parseRpcError()`
* `isTransient()`
* `isPermanent()`
* `formatError()`

This is the core decision mechanism for recovery behavior.


### Program Entry Points

**Transaction processing**
in `programs/TransactionProcessor.ts`

```
processTransaction(...)
```

**Worker system**
in `programs/SettlementWorker.ts`

```
settlementWorker(...)
```

**Application runtime**
in `main.ts`, executed via:

```
Effect.runPromise(main)
```



## 3. Pure Core (Business Logic)

### 3.1 Transaction State Machine

```
PENDING → PROCESSING → SETTLED
                         FAILED
```

Additional terminal path:

* Any permanent failure or retry exhaustion → DLQ

This state machine is enforced through `StorageService` updates.


### 3.2 Processing Pipeline

`processTransaction(txn, ...)` performs:

1. Mark `PROCESSING`
2. Validate transaction parameters
3. Resolve nonce

   * Use in-memory `Ref`
   * If uninitialized (`-1`), fetch from chain
4. Build unsigned transaction
5. Sign transaction
6. Send to blockchain
7. On success

   * Mark `SETTLED`
   * Store hash
   * Increment nonce Ref


### 3.3 Error Decision Engine

All failures are mapped to `SettlementError`.

**Transient errors**

* `NonceToLow`
* `ReplacementFeeTooLow`
* `NetworkError`

Behavior:

* Record error
* If retries < `maxRetries`

  * Update state to `PENDING`
  * Increment retry count
  * Worker retry schedule applies
* Otherwise add to Dead Letter Queue (DLQ)

**Permanent errors**

* `ExecutionReverted`
* `InsufficientFunds`
* `ValidationError`
* `Unknown`
* `DbError`

Behavior:

* Move to DLQ immediately
* Mark `FAILED`

The decision boundary is purely determined by:

```
isTransient(error)
```


### 3.4 Dead Letter Queue (Failure Containment)

Transactions are moved to DLQ when:

* A permanent error occurs
* Transient errors exceed `maxRetries`

DLQ guarantees:

* No infinite retry loops
* Failed transactions are preserved for investigation
* System continues processing other work


## 4. Concurrency Model

### 4.1 Execution Topology

```
Main
  ├── Producer Fiber
  ├── Worker Fiber 1
  ├── Worker Fiber 2
  └── Supervisor
```

### 4.2 Producer

Loop:

* Poll `getPendingTransactions()`
* Filter out already active transactions
* Enqueue new work
* Sleep `pollIntervalMs`

Reliability:

* Protected with `catchAll`
* Defects captured via `catchAllCause`
* Producer never terminates


### 4.3 Active Transaction Deduplication

```
activeTxIds: Ref<Set<string>>
```

Prevents:

* Duplicate queue entries
* Concurrent processing of the same transaction

This ensures **at-most-once in-flight processing**.

### 4.4 Bounded Queue (Backpressure)

```
Queue.bounded(100)
```

Provides:

* Memory safety
* Overload protection
* Decoupling between DB polling and processing speed


### 4.5 Worker Behavior

Workers:

* `Queue.take`
* Run `processTransaction`
* Retry transient failures using exponential schedule
* Always release transaction ID via `ensuring`

Workers are supervised and isolated from each other.

## 5. Nonce Management

Shared state:

```
nonceRef: Ref<number>
```

Initialization strategy:

* Start at `-1`
* First use fetches on-chain nonce
* Increment locally after each success

Recovery:

* On `NonceToLow`, reset Ref to chain value

Guarantees:

* Monotonic nonce usage
* Fast local sequencing
* Crash-safe re-synchronization

## 6. Runtime

Language: TypeScript (Node.js)

Effect system: **Effect TS**

Core primitives used:

* `Effect`
* `Ref`
* `Queue`
* `Schedule`
* `Supervisor`
* `Scope`

### Startup Flow

`main.ts`:

1. Load configuration
2. Initialize database
3. Create provider and signer
4. Construct services
5. Start settlement worker
6. Register shutdown finalizer

Execution:

```
Effect.runPromise(main)
```

The worker runs indefinitely via `Effect.never`.


## 7. Operational Guarantees

The system provides the following invariants:

* **Single nonce stream** per signer
* **At-most-once in-flight processing** via `activeTxIds`
* **Bounded memory usage** via queue backpressure
* **Termination guarantee**: every transaction either settles or reaches DLQ within `maxRetries`
* **Self-healing producer**: polling loop cannot crash permanently
* **Fiber isolation**: worker failures do not affect others
* **Graceful shutdown** via scoped finalizers
