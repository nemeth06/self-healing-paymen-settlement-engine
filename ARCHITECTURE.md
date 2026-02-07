# Architecture Overview (Simple Version)

## What Problem Does This Solve?

A blockchain payment settlement system needs to handle:
- **Nonce issues**: Multiple transactions from same wallet can conflict
- **Gas spikes**: Network conditions change, gas price might need bumping
- **Network flakes**: RPC calls can temporarily fail
- **Bad inputs**: Some transactions will never succeed (bad address, insufficient funds)

This system handles all of these **automatically** without manual intervention.

## How It Works (In Plain English)

### The Loop
```
Every 2 seconds:
  1. Check DB for transactions waiting to be sent ("PENDING")
  2. For each transaction:
     - Build it (construct the data)
     - Sign it (private key)
     - Send it to blockchain via RPC
     - Wait for confirmation
  3. If success → mark as "SETTLED"
  4. If fails with temporary issue → retry automatically
  5. If fails with permanent issue → move to "dead-letter queue"
```

### Temporary Issues (Auto-Retry)
- ✅ "Nonce too low" → Update nonce, retry
- ✅ "Replacement fee too low" → Bump gas price, retry
- ✅ Network timeouts → Exponential backoff, retry

### Permanent Issues (Give Up)
- ❌ Bad recipient address → Move to dead-letter
- ❌ Insufficient balance → Move to dead-letter
- ❌ Transaction would revert → Move to dead-letter

## Tech Stack

| Component | Purpose |
|-----------|---------|
| **Effect-TS v3** | Makes all side effects (DB, RPC, time) composable and testable |
| **ethers.js v6** | Talk to blockchain (Hardhat) |
| **Drizzle ORM** | Access Postgres database |
| **Postgres** | Store transaction status, errors, dead-letters |
| **Hardhat** | Local blockchain for testing |

## Data Model

### transactions table
```
id          → Unique identifier (UUID)
hash        → Blockchain tx hash (null until sent)
status      → PENDING | PROCESSING | SETTLED | FAILED
to_address  → Where to send the funds
value       → How much (in wei)
calldata    → What to do (0x for simple transfer)
gas_limit   → How much gas
retry_count → How many times we tried
last_error  → Most recent error message
created_at  → When inserted
updated_at  → Last change
```

### dead_letter_queue table
```
id              → Unique identifier
transaction_id  → Reference to transactions table
reason          → Why we gave up
error_details   → Full error message
enqueued_at     → When moved to DLQ
```

## File Organization

```
src/
├── main.ts                    ← Start here: app entry point
├── services/                  ← Wrapped API calls
│   ├── ConfigService          ← Load environment variables
│   ├── BlockchainService      ← Wrap ethers.js (RPC calls)
│   └── StorageService         ← Wrap Drizzle (DB queries)
├── programs/                  ← Core settlement logic
│   ├── SettlementWorker       ← Main loop + producer/workers
│   └── TransactionProcessor   ← Process one transaction
├── errors/                    ← Error types
├── db/                        ← Database schema
├── utils/                     ← Helpers (gas calc, tx building)
└── scripts/                   ← Setup scripts
```

## Flow Diagram

```
main.ts
   ↓
Load config → Init DB → Init blockchain provider
   ↓
settlementWorker()
   ├─ Producer fiber
   │  └─ Every 2s: Poll DB for PENDING transactions
   │     └─ Enqueue each to work Queue
   │
   └─ Worker fibers (x2)
      └─ Take from Queue
         └─ processTransaction()
            ├─ Validate
            ├─ Get nonce (from memory or chain)
            ├─ Build transaction
            ├─ Sign it
            ├─ Send to RPC
            ├─ If success → update DB to SETTLED
            ├─ If transient error → retry
            └─ If permanent error → move to DLQ
```

## Why Effect-TS?

Instead of:
```typescript
async function processTransaction(txn) {
  try {
    const nonce = await getNonce();
    const signed = await signTx();
    const hash = await sendTx();
    return { success: true, hash };
  } catch (error) {
    // Where do I handle different errors?
    // How do I know which errors are recoverable?
  }
}
```

We use **Effect** (generators) to compose effects:
```typescript
Effect.gen(function* (_) {
  const nonce = yield* _(blockchain.getNonce()); // Wrapped effect
  const signed = yield* _(signTransaction());    // Wrapped effect
  const hash = yield* _(blockchain.sendRawTx()); // Wrapped effect
  
  // Errors automatically have type information
  if (isTransient(error)) {
    yield* _(update status back to PENDING);
  } else {
    yield* _(moveToDeadLetterQueue());
  }
})
```

Benefits:
- ✅ All side effects are explicit and typed
- ✅ Errors are discriminated (transient vs permanent)
- ✅ Resource cleanup is automatic (DB, provider)
- ✅ Retry logic is built-in (Schedule)
- ✅ Concurrent execution is safe (Ref, Queue, Supervisor)

## Self-Healing Examples

### Example 1: Nonce Conflict
```
Worker 1 sends tx with nonce 5 << Success
Worker 2 sends tx with nonce 5 ✗✗ Error: "nonce too low"
  → RPC gives us: current nonce is 6
  → We update in-memory Ref to 6
  → Worker 2 retries with nonce 6 ✓ Success
```

### Example 2: Gas Price Spike
```
Gas price was 20 gwei, we built tx with that price
Network now requires 30 gwei
RPC rejects: "replacement fee too low"
  → We fetch current gas price (30 gwei)
  → Multiply by 1.2x for bump = 36 gwei
  → Rebuild tx with new gas price
  → Retry ✓ Success
```

### Example 3: Network Timeout
```
First attempt: timeout connecting to RPC
  → Error is NetworkError (transient)
  → Retry with 100ms delay
Second attempt: timeout again
  → Retry with 200ms delay
Third attempt: ✓ Success
```

### Example 4: Bad Address
```
Tx has recipient "0xbadbadbad..."
RPC validates and rejects: "invalid address"
  → Error is ValidationError (permanent)
  → Don't retry, move to dead-letter queue
  → Human reviews in DB
```

## Monitoring

### Check if working
```bash
npm run dev
# Look for logs like:
# [Producer] Found 3 pending transactions
# [Worker-1] Processing 550e8400-...
# Transaction sent: 0x...
# Transaction settled: 550e8400-...
```

### Check results
```sql
SELECT status, COUNT(*) FROM transactions GROUP BY status;
-- SETTLED | 3
-- PENDING | 0

SELECT * FROM dead_letter_queue;
-- (empty if no permanent failures)
```

## What's NOT Implemented (For Hackathon)

- ❌ MEV protection (would need Flashbots or similar)
- ❌ Multi-sig support (single private key only)
- ❌ Batching (processes one tx at a time)
- ❌ Dashboard (logs only, no UI)
- ❌ Mainnet support (Hardhat local only)
- ❌ Custom fee bumping strategies

These can be added but hackathon version keeps it simple!

---

**Next Steps:**
1. Run `npm install && npm run docker:up && npm run migrate && npm run seed`
2. Run `npm run dev` and watch it work
3. Check DB with `psql postgresql://postgres:postgres@localhost:5432/settlement_engine`
4. See [QUICKSTART.md](QUICKSTART.md) for troubleshooting
5. See [EFFECTS.md](EFFECTS.md) for deep technical details
