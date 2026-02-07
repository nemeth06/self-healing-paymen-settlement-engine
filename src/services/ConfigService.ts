import { Effect } from "effect";
import { z } from "zod";

// Environment configuration schema
const configSchema = z.object({
  rpcUrl: z.string().url("RPC_URL must be a valid URL"),
  privateKey: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "PRIVATE_KEY must be a 256-bit hex string"),
  databaseUrl: z.string().url("DATABASE_URL must be a valid PostgreSQL URL"),
  pollIntervalMs: z
    .number()
    .int()
    .positive("POLL_INTERVAL_MS must be a positive integer"),
  maxRetries: z
    .number()
    .int()
    .nonnegative("MAX_RETRIES must be non-negative"),
  maxGasPriceMultiplier: z
    .number()
    .positive("MAX_GAS_PRICE_MULTIPLIER must be positive"),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Load and validate configuration from environment variables
 * Returns an Effect that validates the config or fails with validation errors
 */
export const loadConfig = (): Effect.Effect<Config, Error> =>
  Effect.try({
    try: () => {
      // Load environment variables (dotenv should be called at app entry point)
      const config = {
        rpcUrl: process.env.RPC_URL,
        privateKey: process.env.PRIVATE_KEY,
        databaseUrl: process.env.DATABASE_URL,
        pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "2000", 10),
        maxRetries: parseInt(process.env.MAX_RETRIES || "5", 10),
        maxGasPriceMultiplier: parseFloat(
          process.env.MAX_GAS_PRICE_MULTIPLIER || "2.0"
        ),
      };

      // Validate using zod
      return configSchema.parse(config);
    },
    catch: (error) =>
      new Error(`Configuration validation failed: ${String(error)}`),
  });

/**
 * Service interface for accessing configuration
 */
export interface ConfigService {
  readonly rpcUrl: string;
  readonly privateKey: string;
  readonly databaseUrl: string;
  readonly pollIntervalMs: number;
  readonly maxRetries: number;
  readonly maxGasPriceMultiplier: number;
}

/**
 * Create a ConfigService from loaded configuration
 */
export const ConfigService = (config: Config): ConfigService => ({
  rpcUrl: config.rpcUrl,
  privateKey: config.privateKey,
  databaseUrl: config.databaseUrl,
  pollIntervalMs: config.pollIntervalMs,
  maxRetries: config.maxRetries,
  maxGasPriceMultiplier: config.maxGasPriceMultiplier,
});
