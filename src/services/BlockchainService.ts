import { Effect } from "effect";
import type { ethers } from "ethers";
import { SettlementError, parseRpcError } from "../errors/index.js";

/**
 * Service interface for blockchain interactions
 * All methods return Effect to enable proper resource management and error handling
 */
export interface BlockchainService {
  /**
   * Get the current nonce for an address
   */
  getNonce(address: string): Effect.Effect<number, SettlementError>;

  /**
   * Estimate gas for a transaction
   */
  estimateGas(tx: UnsignedTx): Effect.Effect<bigint, SettlementError>;

  /**
   * Get current gas price from network
   */
  getGasPrice(): Effect.Effect<bigint, SettlementError>;

  /**
   * Send a signed transaction to the network
   */
  sendRawTx(signedTx: string): Effect.Effect<string, SettlementError>;

  /**
   * Get transaction receipt (returns null if not mined yet)
   */
  getTxReceipt(
    hash: string
  ): Effect.Effect<ethers.TransactionResponse | null, SettlementError>;

  /**
   * Wait for transaction to be mined
   */
  waitForTx(
    hash: string,
    confirmations?: number
  ): Effect.Effect<ethers.TransactionReceipt | null, SettlementError>;
}

/**
 * Unsigned transaction representation
 */
export interface UnsignedTx {
  to: string;
  from: string;
  value: string; // wei as string to preserve precision
  data: string; // calldata
  gasLimit: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce: number;
  chainId: number;
}

/**
 * Create a BlockchainService instance
 * Wraps ethers.js provider and signer in Effects for proper error handling
 */
export const BlockchainService = (
  provider: ethers.JsonRpcProvider | ethers.Provider,
  signer: ethers.Signer
): BlockchainService => {
  const typedProvider = provider as ethers.JsonRpcProvider;

  const getNonce = (address: string): Effect.Effect<number, SettlementError> =>
    Effect.tryPromise({
      try: async () => {
        const nonce = await typedProvider.getTransactionCount(address);
        return nonce;
      },
      catch: (error) =>
        parseRpcError(error) as SettlementError,
    });

  const estimateGas = (
    tx: UnsignedTx
  ): Effect.Effect<bigint, SettlementError> =>
    Effect.tryPromise({
      try: async () => {
        const estimation = await typedProvider.estimateGas({
          to: tx.to,
          from: tx.from,
          value: tx.value,
          data: tx.data,
        });
        return estimation;
      },
      catch: (error) =>
        parseRpcError(error) as SettlementError,
    });

  const getGasPrice = (): Effect.Effect<bigint, SettlementError> =>
    Effect.tryPromise({
      try: async () => {
          const feeData = await typedProvider.getFeeData();
        const gasPrice = feeData.gasPrice ?? BigInt(0);
        return gasPrice;
      },
      catch: (error) =>
        parseRpcError(error) as SettlementError,
    });

  const sendRawTx = (signedTx: string): Effect.Effect<string, SettlementError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await typedProvider.broadcastTransaction(signedTx);
        return response.hash;
      },
      catch: (error) =>
        parseRpcError(error) as SettlementError,
    });

  const getTxReceipt = (
    hash: string
  ): Effect.Effect<ethers.TransactionResponse | null, SettlementError> =>
    Effect.tryPromise({
      try: async () => {
        const receipt = await typedProvider.getTransaction(hash);
        return receipt;
      },
      catch: (error) =>
        parseRpcError(error) as SettlementError,
    });

  const waitForTx = (
    hash: string,
    confirmations: number = 1
  ): Effect.Effect<ethers.TransactionReceipt | null, SettlementError> =>
    Effect.tryPromise({
      try: async () => {
        const receipt = await typedProvider.waitForTransaction(
          hash,
          confirmations,
          60000 // 60 second timeout per confirmation
        );
        return receipt;
      },
      catch: (error) =>
        parseRpcError(error) as SettlementError,
    });

  return {
    getNonce,
    estimateGas,
    getGasPrice,
    sendRawTx,
    getTxReceipt,
    waitForTx,
  };
};
