// Shared domain types for DMZ services
export type ChainId = 1 | 137 | 31337; // mainnet, polygon, hardhat

export interface ChainEvent {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  eventName: string;
  contractAddr: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface TransactionReceipt {
  txHash: string;
  blockNumber: bigint;
  status: 'success' | 'reverted';
  gasUsed: bigint;
  confirmations: number;
}

export interface UserAccount {
  userId: string;
  walletAddress: string | null;
  kycLevel: 'NONE' | 'BASIC' | 'ENHANCED' | 'INVESTOR';
  isActive: boolean;
}
