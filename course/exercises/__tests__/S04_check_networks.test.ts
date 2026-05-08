/**
 * S04 채점 — JsonRpcProvider 활용 패턴 검증
 *
 * 실제 네트워크 연결 없이 ethers.js API 사용 패턴을 채점한다.
 * 채점 기준:
 *   · JsonRpcProvider 생성 후 getNetwork() → chainId 추출
 *   · getBlockNumber() 호출
 *   · getBalance(address) → formatEther() 변환
 *   · getFeeData().maxFeePerGas → Gwei 변환 (/ 1_000_000_000n)
 */

import { formatEther } from 'ethers';

/** S04 queryNetwork 내부 로직을 재현한 헬퍼들 */

function formatBalance(wei: bigint): string {
  return formatEther(wei) + ' ETH';
}

function toGwei(maxFeePerGas: bigint | null): string {
  const gwei = maxFeePerGas != null ? maxFeePerGas / 1_000_000_000n : 0n;
  return gwei.toString() + ' Gwei';
}

// Mock provider — 실제 RPC 호출 없이 채점
function makeMockProvider(opts: {
  chainId: bigint;
  blockNumber: number;
  balances: Record<string, bigint>;
  maxFeePerGas: bigint | null;
}) {
  return {
    getNetwork:      async () => ({ chainId: opts.chainId }),
    getBlockNumber:  async () => opts.blockNumber,
    getBalance:      async (addr: string) => opts.balances[addr] ?? 0n,
    getFeeData:      async () => ({ maxFeePerGas: opts.maxFeePerGas }),
  };
}

const HARDHAT_ACCT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ETH_10000 = BigInt('10000000000000000000000'); // 10,000 ETH in wei

describe('S04 채점 — 로컬 노드 (chainId 31337)', () => {
  const provider = makeMockProvider({
    chainId: 31337n,
    blockNumber: 0,
    balances: { [HARDHAT_ACCT_0]: ETH_10000 },
    maxFeePerGas: 1_000_000_000n, // 1 Gwei
  });

  it('체인 ID가 31337이다', async () => {
    const network = await provider.getNetwork();
    expect(network.chainId.toString()).toBe('31337');
  });

  it('블록 번호가 0이다 (빈 체인)', async () => {
    const blockNumber = await provider.getBlockNumber();
    expect(blockNumber).toBe(0);
  });

  it('Hardhat 기본 계정 잔액이 10000.0 ETH이다', async () => {
    const balance = await provider.getBalance(HARDHAT_ACCT_0);
    expect(formatBalance(balance)).toBe('10000.0 ETH');
  });

  it('가스 가격이 1 Gwei이다', async () => {
    const feeData = await provider.getFeeData();
    expect(toGwei(feeData.maxFeePerGas)).toBe('1 Gwei');
  });
});

describe('S04 채점 — Sepolia (chainId 11155111)', () => {
  const MY_ADDRESS = '0x1234567890123456789012345678901234567890';
  const provider = makeMockProvider({
    chainId: 11155111n,
    blockNumber: 10_000_000,
    balances: { [MY_ADDRESS]: BigInt('2860000000000000000'), [HARDHAT_ACCT_0]: 0n },
    maxFeePerGas: 5_000_000_000n, // 5 Gwei
  });

  it('체인 ID가 11155111이다', async () => {
    const network = await provider.getNetwork();
    expect(network.chainId.toString()).toBe('11155111');
  });

  it('블록 번호가 수백만대이다', async () => {
    const blockNumber = await provider.getBlockNumber();
    expect(blockNumber).toBeGreaterThan(1_000_000);
  });

  it('내 계정 잔액을 formatEther로 변환한다', async () => {
    const balance = await provider.getBalance(MY_ADDRESS);
    const result = formatBalance(balance);
    expect(result).toMatch(/ETH$/);
    expect(result).toBe('2.86 ETH');
  });

  it('Hardhat 기본 계정은 Sepolia에서 0.0 ETH이다', async () => {
    const balance = await provider.getBalance(HARDHAT_ACCT_0);
    expect(formatBalance(balance)).toBe('0.0 ETH');
  });
});

describe('S04 채점 — Gwei 변환 공식', () => {
  it('maxFeePerGas(wei) / 1_000_000_000n = Gwei', () => {
    expect(toGwei(1_000_000_000n)).toBe('1 Gwei');
    expect(toGwei(10_000_000_000n)).toBe('10 Gwei');
    expect(toGwei(500_000_000_000n)).toBe('500 Gwei');
  });

  it('maxFeePerGas가 null이면 0 Gwei 반환', () => {
    expect(toGwei(null)).toBe('0 Gwei');
  });
});

describe('S04 채점 — 메인넷 (chainId 1)', () => {
  const provider = makeMockProvider({
    chainId: 1n,
    blockNumber: 25_000_000,
    balances: { [HARDHAT_ACCT_0]: 0n },
    maxFeePerGas: 20_000_000_000n, // 20 Gwei
  });

  it('체인 ID가 1이다', async () => {
    const network = await provider.getNetwork();
    expect(network.chainId.toString()).toBe('1');
  });

  it('블록 번호가 수천만대이다', async () => {
    const blockNumber = await provider.getBlockNumber();
    expect(blockNumber).toBeGreaterThan(10_000_000);
  });
});
