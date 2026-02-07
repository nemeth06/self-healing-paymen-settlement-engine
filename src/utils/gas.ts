import { Effect } from "effect";
import { ethers } from "ethers";
import { SettlementError } from "../errors/index.js";
import { UnsignedTx } from "../services/BlockchainService.js";

/**
 * Estimate gas and apply a percentage buffer for safety
 * This accounts for variability in gas consumption
 */
export const estimateGasWithBuffer = (
  estimatedGas: bigint,
  bufferPercent: number = 20
): bigint => {
  const buffer = (estimatedGas * BigInt(bufferPercent)) / BigInt(100);
  return estimatedGas + buffer;
};

/**
 * Calculate new gas price when "Replacement fee too low" error occurs
 * Applies a multiplier to the transaction's existing gas price
 */
export const calculateReplacementGasPrice = (
  currentGasPrice: bigint,
  multiplier: number = 1.2
): bigint => {
  const newPrice = currentGasPrice * BigInt(Math.ceil(multiplier * 100)) / BigInt(100);
  return newPrice;
};

/**
 * Build an unsigned transaction from stored transaction data
 */
export const buildUnsignedTx = (params: {
  toAddress: string;
  fromAddress: string;
  value: string;
  calldata: string;
  nonce: number;
  gasLimit: string;
  gasPrice: bigint;
  chainId: number;
}): UnsignedTx => {
  return {
    to: params.toAddress,
    from: params.fromAddress,
    value: params.value,
    data: params.calldata,
    gasLimit: params.gasLimit,
    gasPrice: params.gasPrice.toString(),
    nonce: params.nonce,
    chainId: params.chainId,
  };
};

/**
 * Sign an unsigned transaction with a signer
 */
export const signTransaction = (
  signer: ethers.Signer,
  unsignedTx: UnsignedTx
): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const txObj = {
        to: unsignedTx.to,
        from: unsignedTx.from,
        value: unsignedTx.value,
        data: unsignedTx.data,
        gasLimit: unsignedTx.gasLimit,
        gasPrice: unsignedTx.gasPrice,
        nonce: unsignedTx.nonce,
        chainId: unsignedTx.chainId,
      };
      const signed = await signer.signTransaction(txObj);
      return signed;
    },
    catch: (error) => new Error(`Failed to sign: ${String(error)}`),
  });

export const validateTransaction = (tx: UnsignedTx): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!ethers.isAddress(tx.to)) throw new Error(`Invalid to: ${tx.to}`);
    if (!ethers.isAddress(tx.from)) throw new Error(`Invalid from: ${tx.from}`);
    if (BigInt(tx.value) < 0n) throw new Error(`Negative value: ${tx.value}`);
    if (!tx.data.startsWith("0x")) throw new Error(`Invalid data: ${tx.data}`);
  });
