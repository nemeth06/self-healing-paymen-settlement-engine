# QUICKSTART

## 1-2-3-4 Setup
```bash
npm install
npm run docker:up
npm run migrate
npm run seed
npm run dev
```

## In another terminal (check results)
```bash
psql postgresql://postgres:postgres@localhost:5432/settlement_engine
SELECT * FROM transactions;
SELECT * FROM dead_letter_queue;
```

## Stop everything
```bash
npm run docker:down
```

## Key Files to Understand

| File | What it does |
|------|-------------|
| `src/main.ts` | App startup, load config, init DB, start worker |
| `src/programs/SettlementWorker.ts` | Producer-consumer loop, polls DB, spawns workers |
| `src/programs/TransactionProcessor.ts` | Process one transaction, handle errors, retry logic |
| `src/services/BlockchainService.ts` | Wrap ethers.js RPC calls in Effect |
| `src/services/StorageService.ts` | Wrap Drizzle DB queries in Effect |
| `src/services/ConfigService.ts` | Load .env, validate with Zod |
| `src/errors/index.ts` | Error types, discriminate transient vs permanent |
| `src/db/schema.ts` | Drizzle tables: transactions, dead_letter_queue |

## How it works

```
1. Config loaded from .env
2. DB initialized (Postgres)
3. Blockchain provider created (ethers.js → Hardhat)
4. Worker starts polling DB every 2s for PENDING txns
5. For each PENDING:
   - Sign with private key
   - Send to blockchain
   - If success: mark SETTLED
   - If transient error: retry with backoff
   - If permanent error: move to dead-letter queue
```

## Debugging

**View logs**
```bash
npm run dev 2>&1 | grep "error\|failed\|retry"
```

**Check transaction status**
```sql
SELECT id, status, retry_count, last_error FROM transactions WHERE status != 'SETTLED';
```

**Test with bad address (will fail permanently)**
```sql
INSERT INTO transactions (id, to_address, value, calldata, gas_limit, status)
VALUES (gen_random_uuid(), 'not-an-address', '100000000000000000', '0x', '21000', 'PENDING');
```

## Env Variables (in .env)

- `RPC_URL` - Hardhat endpoint
- `PRIVATE_KEY` - Signer wallet (has ETH on Hardhat)
- `DATABASE_URL` - Postgres
- `POLL_INTERVAL_MS` - How often to check DB (2000 = 2s)
- `MAX_RETRIES` - Max attempts per transaction (5)

## Effect-TS Key Concepts

- **Effect.gen**: Compose effects like async/await
- **Ref**: In-memory mutable reference (nonce tracking)
- **Queue**: Work queue between producer/workers
- **Schedule**: Retry logic with exponential backoff
- **Scope**: Resource lifecycle (DB, provider cleanup)

## Common Issues

**"Nonce too low"**
- Worker automatically updates in-memory Ref and retries
- Check logs for "Updating nonce"

**"Replacement fee too low"**
- Worker retries with bumped gas price
- Automatic, no manual intervention needed

**Transactions stuck in PROCESSING**
- Kill worker, manually update: `UPDATE transactions SET status='PENDING' WHERE status='PROCESSING'`
- Restart worker

**DB won't connect**
- Check Docker: `docker ps | grep postgres`
- Logs: `docker logs settlement-engine-db`
- Restart: `npm run docker:down && npm run docker:up`

---

See [EFFECTS.md](EFFECTS.md) for detailed architecture and [README.md](README.md) for full docs.
