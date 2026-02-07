import "dotenv/config";
import { Effect, Scope } from "effect";
import { ethers } from "ethers";
import { loadConfig, ConfigService } from "./services/ConfigService.js";
import { BlockchainService } from "./services/BlockchainService.js";
import { StorageService } from "./services/StorageService.js";
import { initDb, type DbClient } from "./db/client.js";
import { settlementWorker } from "./programs/SettlementWorker.js";

/**
 * Main application entry point
 *
 * Responsibility:
 * - Load configuration from environment
 * - Initialize resources (DB, ethers provider/signer)
 * - Create service instances
 * - Launch settlement worker
 * - Clean up resources on exit via Effect.scoped
 *
 * All resource management is handled via Effect.scoped and
 * Effect.acquireRelease to ensure proper cleanup on error or shutdown.
 */
const main = Effect.scoped(
  Effect.gen(function* (_ : Effect.Adapter) {
    // Load configuration
    yield* _(Effect.log("[App] Loading configuration..."));
    const config = yield* _(loadConfig());
    const configService = ConfigService(config);
    yield* _(
      Effect.log(
        `[App] Config loaded: RPC=${config.rpcUrl}, pollInterval=${config.pollIntervalMs}ms`
      )
    );

    // Initialize database
    yield* _(Effect.log("[App] Initializing database..."));
    const db: DbClient = yield* _(initDb(config.databaseUrl));
    yield* _(Effect.log("[App] Database initialized"));

    // Initialize ethers.js provider and signer
    yield* _(Effect.log("[App] Initializing blockchain provider..."));
    const provider = new ethers.JsonRpcProvider(config.rpcUrl, ethers.Network.from(config.rpcId));
    const signer = new ethers.Wallet(config.privateKey, provider);
    const signerAddress = yield* _(Effect.promise(() => signer.getAddress()));

    yield* _(Effect.log(`[App] Blockchain provider initialized: ${signerAddress}`));

    // Create service instances
    const blockchain = BlockchainService(provider, signer);
    const storage = StorageService(db);

    // Log startup status
    yield* _(Effect.log("[App] ========================================"));
    yield* _(Effect.log("[App] Self-Healing Payment Settlement Engine"));
    yield* _(Effect.log("[App] ========================================"));
    yield* _(
      Effect.log(`[App] Signer Address: ${signerAddress}`)
    );
    yield* _(
      Effect.log(`[App] Poll Interval: ${config.pollIntervalMs}ms`)
    );
    yield* _(
      Effect.log(`[App] Max Retries: ${config.maxRetries}`)
    );
    yield* _(Effect.log("[App] Starting settlement worker..."));
    yield* _(Effect.log("[App] ========================================"));

    yield* _(Effect.log("Connecting to Plasma Testnet..."));

  // Fetch Network Info
  const network = yield* _(
    Effect.tryPromise({
      try: () => provider.getNetwork(),
      catch: (e) => new Error(`Network Error: ${e}`),
    })
  );

  // Fetch Block Number
  const blockNumber = yield* _(
    Effect.tryPromise({
      try: () => provider.getBlockNumber(),
      catch: (e) => new Error(`Block Error: ${e}`),
    })
  );

  // Log Results
  yield* _(
    Effect.log(`Connected to Chain ID: ${network.chainId} (${network.name})`)
  );
  yield* _(Effect.log(`Current Block: ${blockNumber}`));

    // Add finalizers for graceful shutdown
    const scope = yield* _(Scope.make());
    yield* _(
      Scope.addFinalizer(
        //yield* _(Scope.current()),
        scope,
        Effect.log("[App] Shutting down gracefully...")
      )
    );

    // Launch settlement worker (runs indefinitely)
    yield* _(settlementWorker(blockchain, storage, configService, signer));
  })
);

/**
 * Execute the main Effect
 * Effect.runPromise ensures proper async handling and cleanup
 */
Effect.runPromise(main).catch((error) => {
  console.error("[App] Fatal error:", error);
  process.exit(1);
});
