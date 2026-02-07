# Self-Healing Payment Settlement Engine

A blockchain payment settlement system built with Effect-TS v3, ethers.js v6, and Drizzle ORM.

## Quick Start

### Prerequisites
- Node.js 20+
- Docker Compose

### Setup
```bash
# Install dependencies
npm install

# Start services (Postgres + Hardhat)
npm run docker:up

# Wait ~10 seconds for services to be healthy

# Create database schema
npm run migrate

# Seed test transactions
npm run seed

# Start settlement worker
npm run dev
```

The worker will poll for PENDING transactions and settle them with automatic retry logic for transient errors.

## Key Features

- **Effect-TS v3**: All side effects (RPC, DB, time, concurrency) as composable Effects
- **Self-Healing**: Automatic recovery from "Nonce too low" and "Replacement fee too low" errors
- **Producer-Consumer**: Queue-based worker pattern with supervised fibers
- **Discriminated Errors**: Smart routing of transient vs permanent failures
- **Dead-Letter Queue**: Failed transactions moved to DLQ table for inspection

## Project Structure

```
src/
├── main.ts                 # App entry, resource management
├── services/               # BlockchainService, StorageService, ConfigService
├── programs/               # SettlementWorker, TransactionProcessor
├── errors/                 # SettlementError types & helpers
├── db/                     # Drizzle schema, client
├── utils/                  # Gas utilities, tx building
└── scripts/                # Seed data script
```

## Database

### transactions
- `id` (UUID PK): Transaction identifier
- `status` (enum): PENDING | PROCESSING | SETTLED | FAILED
- `hash` (varchar): On-chain transaction hash
- `toAddress`, `value`, `calldata`, `gasLimit`, `retryCount`
- `createdAt`, `updatedAt`

### dead_letter_queue
- `id` (UUID PK): DLQ entry
- `transactionId` (FK): Reference to transactions
- `reason`, `errorDetails`, `enqueuedAt`

## Environment

```env
RPC_URL=http://localhost:8545
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb476c6b8d6c6712b08d077d5e592
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/settlement_engine
POLL_INTERVAL_MS=2000
MAX_RETRIES=5
```

## What It Does

1. **Polling**: Producer checks DB every 2 seconds for PENDING transactions
2. **Processing**: Worker processes transactions via RPC (sign → broadcast → confirm)
3. **Recovery**: 
   - Nonce too low → updates Ref, retries
   - Replacement fee too low → bumps gas, retries
   - Network error → exponential backoff retry
   - Permanent error → moves to dead-letter queue

## Testing

```bash
# Check transactions
psql postgresql://postgres:postgres@localhost:5432/settlement_engine
SELECT id, status, hash, retry_count FROM transactions ORDER BY createdAt DESC;

# Check dead-letter queue
SELECT * FROM dead_letter_queue;

# View logs
npm run dev 2>&1 | tee settlement.log
```

## Architecture Details

See [EFFECTS.md](EFFECTS.md) for detailed effect system documentation covering:
- **I/O Boundary**: Network, storage, time, concurrency, logging effects
- **Effect Definitions**: Code references for all services and error types
- **Pure Core**: Deterministic settlement logic and recovery paths
- **Runtime**: Effect-TS v3 execution model and resource management

## Deployment

For hackathon:
- Run locally via `npm run dev`
- Services run in Docker (postgres + hardhat)
- Single worker with 2 concurrent fibers
- Add monitoring/alerts as needed

## Troubleshooting

**Transactions stuck in PENDING**
```sql
UPDATE transactions SET status='PROCESSING' WHERE status='PENDING';
```

**Check nonce mismatch**
- Worker logs show nonce updates via Effect.log
- DB stores last error in `lastError` column

**Reset database**
```bash
npm run docker:down
npm run docker:up
npm run migrate
npm run seed
```
