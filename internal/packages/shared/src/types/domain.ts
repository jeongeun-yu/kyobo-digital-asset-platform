// Shared domain types for internal network services
export type ChainId = 1 | 137 | 31337; // mainnet, polygon, hardhat

// ChainEvent / TransactionReceipt 는 @kyobo/chain-adapters 가 단일 정의 원천
export type { ChainEvent, TransactionReceipt } from '@kyobo/chain-adapters';

export interface UserAccount {
  userId: string;
  walletAddress: string | null;
  kycLevel: 'NONE' | 'BASIC' | 'ENHANCED' | 'INVESTOR';
  isActive: boolean;
}
