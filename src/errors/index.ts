/**
 * Discriminated Union of all settlement-related errors
 * Enables structured error handling and recovery logic
 */
export type SettlementError =
  | {
      _tag: "NonceToLow";
      currentNonce: number;
      txNonce: number;
      address: string;
    }
  | {
      _tag: "ReplacementFeeTooLow";
      txHash: string;
      currentGasPrice: bigint;
      txGasPrice: bigint;
    }
  | {
      _tag: "InsufficientFunds";
      address: string;
      requiredBalance: string;
      actualBalance: string;
    }
  | {
      _tag: "ExecutionReverted";
      reason: string;
      data?: string;
    }
  | {
      _tag: "NetworkError";
      message: string;
      code?: string;
    }
  | {
      _tag: "DbError";
      message: string;
      operation: string;
    }
  | {
      _tag: "ValidationError";
      message: string;
      field: string;
    }
  | {
      _tag: "Unknown";
      underlying: Error;
    };

/**
 * Attempt to parse an RPC error from ethers.js or other sources
 * Maps common RPC error codes to structured SettlementError types
 */
export const parseRpcError = (error: unknown): SettlementError => {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const code = (error as any).code?.toLowerCase() || "";

    // Nonce too low errors
    if (
      message.includes("nonce too low") ||
      message.includes("nonce is too low") ||
      code === "nonce_too_low"
    ) {
      const match = message.match(/nonce\s+(\d+).*(\d+)/);
      return {
        _tag: "NonceToLow",
        currentNonce: match ? parseInt(match[1]) : -1,
        txNonce: match ? parseInt(match[2]) : -1,
        address: (error as any).address || "unknown",
      };
    }

    // Replacement fee too low errors
    if (
      message.includes("replacement fee too low") ||
      message.includes("gas price too low") ||
      code === "replacement_fee_too_low"
    ) {
      return {
        _tag: "ReplacementFeeTooLow",
        txHash: (error as any).hash || (error as any).txHash || "pending-broadcast",
        currentGasPrice: BigInt(0),
        txGasPrice: BigInt(0),
      };
    }

    // Insufficient funds errors
    if (
      message.includes("insufficient funds") ||
      message.includes("insufficient balance") ||
      code === "insufficient_funds"
    ) {
      return {
        _tag: "InsufficientFunds",
        address: (error as any).address || "unknown",
        requiredBalance: (error as any).requiredBalance || "0",
        actualBalance: (error as any).actualBalance || "0",
      };
    }

    // Execution reverted errors
    if (
      message.includes("execution reverted") ||
      message.includes("reverted") ||
      code === "execution_reverted"
    ) {
      return {
        _tag: "ExecutionReverted",
        reason: (error as any).reason || message,
        data: (error as any).data,
      };
    }

    // Network-level errors
    if (
      message.includes("network") ||
      message.includes("enotfound") ||
      message.includes("econnrefused") ||
      code.includes("network") ||
      code.includes("enotfound")
    ) {
      return {
        _tag: "NetworkError",
        message,
        code,
      };
    }

    // Fallthrough: unknown error
    return {
      _tag: "Unknown",
      underlying: error,
    };
  }

  return {
    _tag: "Unknown",
    underlying: new Error(String(error)),
  };
};

/**
 * Determine if an error is transient (can be retried)
 * Transient errors: network issues, temporary gas spikes, nonce conflicts
 */
export const isTransient = (error: SettlementError): boolean => {
  switch (error._tag) {
    case "NonceToLow":
    case "ReplacementFeeTooLow":
    case "NetworkError":
      return true;
    case "ExecutionReverted":
    case "InsufficientFunds":
    case "ValidationError":
      return false;
    case "DbError":
    case "Unknown":
      return false; // Assume permanent until proven otherwise
    default:
      return false;
  }
};

/**
 * Determine if an error is permanent (should not be retried)
 * Permanent errors: validation, execution reverts, insufficient funds
 */
export const isPermanent = (error: SettlementError): boolean => {
  return !isTransient(error);
};

/**
 * Format error for logging
 */
export const formatError = (error: SettlementError): string => {
  switch (error._tag) {
    case "NonceToLow":
      return `Nonce too low: current=${error.currentNonce}, tx=${error.txNonce}, address=${error.address}`;
    case "ReplacementFeeTooLow":
      return `Replacement fee too low for tx ${error.txHash}`;
    case "InsufficientFunds":
      return `Insufficient funds for ${error.address}: required=${error.requiredBalance}, actual=${error.actualBalance}`;
    case "ExecutionReverted":
      return `Execution reverted: ${error.reason}`;
    case "NetworkError":
      return `Network error: ${error.message}`;
    case "DbError":
      return `Database error in ${error.operation}: ${error.message}`;
    case "ValidationError":
      return `Validation error on field '${error.field}': ${error.message}`;
    case "Unknown":
      return `Unknown error: ${error.underlying.message}`;
    default:
      return "Unknown error type";
  }
};
