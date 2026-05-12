/**
 * 실습 환경 설정 로더
 *
 * 모노레포 루트(dmz/)의 .env 파일을 로드한다.
 * 모든 패키지 실습에서 import { config } from '@kyobo/shared' 로 사용.
 *
 * 우선순위: 실제 환경변수 > .env 파일 > 기본값
 */

import path from 'path';
import fs   from 'fs';
import dotenv from 'dotenv';

// 어느 패키지에서 import하든 레포 루트 .env를 찾아 로드
// shared/src → packages → dmz → root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENV_PATH  = path.join(REPO_ROOT, '.env');

if (fs.existsSync(ENV_PATH)) {
  dotenv.config({ path: ENV_PATH });
} else {
  console.warn(`[config] .env 파일 없음: ${ENV_PATH}`);
  console.warn(`[config] 레포 루트의 .env.example 을 복사해 .env를 만드세요.`);
}

// ── EVM ──────────────────────────────────────────────────────────────────────

export const evmConfig = {
  rpcUrl:     process.env['EVM_RPC_URL']    ?? 'https://ethereum-sepolia-rpc.publicnode.com',
  chainId:    process.env['EVM_CHAIN_ID']   ?? '11155111',
  signerKey:  process.env['EVM_SIGNER_KEY'] ?? undefined,
} as const;

// ── XRPL ─────────────────────────────────────────────────────────────────────

export const xrplConfig = {
  wsUrl: process.env['XRPL_WS_URL'] ?? 'wss://xrplcluster.com',
  seed:  process.env['XRPL_SEED']   ?? undefined,
} as const;

// ── Circle ────────────────────────────────────────────────────────────────────

export const circleConfig = {
  apiKey:  process.env['CIRCLE_API_KEY']  ?? '',
  baseUrl: process.env['CIRCLE_BASE_URL'] ?? 'https://api-sandbox.circle.com',
} as const;

// ── 실습용 컨트랙트 주소 ──────────────────────────────────────────────────────

export const contractConfig = {
  mockERC1155: process.env['MOCK_CONTRACT_ADDR'] ?? '',
} as const;

// ── Bitcoin (UTXO) ────────────────────────────────────────────────────────────

export const utxoConfig = {
  rpcUrl:  process.env['BITCOIN_RPC_URL']  ?? 'http://localhost:8332',
  network: (process.env['BITCOIN_NETWORK'] ?? 'testnet') as 'mainnet' | 'testnet',
} as const;
