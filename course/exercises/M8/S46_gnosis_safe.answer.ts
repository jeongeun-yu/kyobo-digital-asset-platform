/**
 * S46 실습 — 다중 서명 기반 키 거버넌스: Gnosis Safe 2-of-3 구조 시뮬레이션
 *
 * 강의 노트: M8_S46_gnosis_safe.md
 *
 * 실행 방법 (루트에서): npm run exercise:s46
 *
 * 목표:
 *   [1] Safe 배포 — threshold=2, 서명자 3명(A·B·C) 설정 확인
 *   [2] 단일 HOT 키 구조(1-of-1)와 2-of-3 보안 차이 비교
 *   [3] EIP-712 SafeTx 해시 계산 (domainSeparator + structHash)
 *   [4] swapOwner TX 구조 — 서명자 교체 시나리오
 *   [5] 2-of-3 핵심 원리: 1명 탈취 시 시스템 보호 확인
 */

import { ethers } from 'ethers';
import { randomBytes } from 'crypto';

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

export type SafeOperation = 0 | 1; // 0 = CALL, 1 = DELEGATECALL

export interface SafeTxParams {
  to: string;
  value: bigint;
  data: string;
  operation: SafeOperation;
  safeTxGas?: bigint;
  baseGas?: bigint;
  gasPrice?: bigint;
  gasToken?: string;
  refundReceiver?: string;
  nonce?: bigint;
}

export interface SafeConfig {
  owners: string[];
  threshold: number;
  chainId: number;
}

// ─── EIP-712 상수 ─────────────────────────────────────────────────────────────

export const SAFE_TX_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'SafeTx(address to,uint256 value,bytes data,uint8 operation,' +
    'uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,' +
    'address gasToken,address refundReceiver,uint256 nonce)',
  ),
);

export const DOMAIN_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes('EIP712Domain(uint256 chainId,address verifyingContract)'),
);

// ─── Gnosis Safe 시뮬레이션 ────────────────────────────────────────────────────

export class SimulatedGnosisSafe {
  private _owners: string[];
  private _threshold: number;
  private _nonce: bigint = 0n;
  readonly address: string;
  readonly chainId: number;

  constructor(config: SafeConfig) {
    if (config.owners.length < config.threshold) {
      throw new Error('threshold cannot exceed number of owners');
    }
    if (config.threshold < 1) {
      throw new Error('threshold must be at least 1');
    }
    this._owners = [...config.owners];
    this._threshold = config.threshold;
    this.chainId = config.chainId;
    // 결정론적 주소 시뮬레이션 (실제는 CREATE2)
    this.address = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(config)),
    ).slice(0, 42);
  }

  getOwners(): string[] { return [...this._owners]; }
  getThreshold(): number { return this._threshold; }
  getNonce(): bigint { return this._nonce; }

  // EIP-712 domainSeparator 계산
  domainSeparator(): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256', 'address'],
        [DOMAIN_TYPEHASH, this.chainId, this.address],
      ),
    );
  }

  // SafeTx 구조체 해시 계산
  getTransactionHash(params: SafeTxParams): string {
    const p = {
      to:             params.to,
      value:          params.value,
      data:           params.data,
      operation:      params.operation,
      safeTxGas:      params.safeTxGas ?? 0n,
      baseGas:        params.baseGas ?? 0n,
      gasPrice:       params.gasPrice ?? 0n,
      gasToken:       params.gasToken ?? ethers.ZeroAddress,
      refundReceiver: params.refundReceiver ?? ethers.ZeroAddress,
      nonce:          params.nonce ?? this._nonce,
    };

    const dataHash  = ethers.keccak256(params.data);
    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address', 'uint256', 'bytes32', 'uint8',
         'uint256', 'uint256', 'uint256', 'address', 'address', 'uint256'],
        [
          SAFE_TX_TYPEHASH, p.to, p.value, dataHash, p.operation,
          p.safeTxGas, p.baseGas, p.gasPrice, p.gasToken, p.refundReceiver, p.nonce,
        ],
      ),
    );

    // EIP-712 최종 해시: keccak256(0x1901 + domainSeparator + structHash)
    return ethers.keccak256(
      ethers.concat(['0x1901', this.domainSeparator(), structHash]),
    );
  }

  // 서명 검증 (ecrecover 시뮬레이션)
  verifySignature(txHash: string, signature: string): string {
    return ethers.recoverAddress(txHash, signature);
  }

  // execTransaction: 서명 수 검증 + 실행 시뮬레이션
  execTransaction(
    params: SafeTxParams,
    signatures: Array<{ signer: string; signature: string }>,
  ): { txHash: string; success: boolean } {
    // 1. 서명 검증
    const safeTxHash = this.getTransactionHash(params);
    const validSigners = new Set<string>();

    for (const { signer, signature } of signatures) {
      const recovered = this.verifySignature(safeTxHash, signature);
      if (recovered.toLowerCase() === signer.toLowerCase() && this._owners.includes(signer)) {
        validSigners.add(signer.toLowerCase());
      }
    }

    // 2. threshold 확인 — Safe GS020 에러 시뮬레이션
    if (validSigners.size < this._threshold) {
      throw new Error(
        `GS020: Insufficient signatures. Got ${validSigners.size}, required ${this._threshold}`,
      );
    }

    // 3. nonce 증가 (재생 공격 방지)
    this._nonce++;

    return { txHash: `0x${randomBytes(32).toString('hex')}`, success: true };
  }

  // swapOwner TX 데이터 생성
  buildSwapOwnerData(oldOwner: string, newOwner: string): string {
    // swapOwner(address prevOwner, address oldOwner, address newOwner) selector
    const iface = new ethers.Interface([
      'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
    ]);
    // prevOwner: 링크드 리스트에서 oldOwner 이전 노드 (Simple: SENTINEL = 0x1)
    const SENTINEL = '0x0000000000000000000000000000000000000001';
    return iface.encodeFunctionData('swapOwner', [SENTINEL, oldOwner, newOwner]);
  }

  // 소유자 교체 (swapOwner TX 실행 후)
  applySwapOwner(oldOwner: string, newOwner: string): void {
    const idx = this._owners.indexOf(oldOwner);
    if (idx === -1) throw new Error(`Owner not found: ${oldOwner}`);
    this._owners[idx] = newOwner;
  }
}

// ─── 단일 HOT 키 vs 2-of-3 비교 ─────────────────────────────────────────────

export interface SingleKeySystem {
  hotKey: ethers.Wallet;
  execute(action: string): string;
}

export function createSingleKeySystem(): SingleKeySystem {
  const hotKey = ethers.Wallet.createRandom();
  return {
    hotKey,
    execute(action: string): string {
      // 단일 키로 무조건 실행 — 키 탈취 = 시스템 장악
      return `${action} executed by ${hotKey.address}`;
    },
  };
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

export function makeSigner(): { wallet: ethers.Wallet; address: string } {
  const wallet = ethers.Wallet.createRandom();
  return { wallet, address: wallet.address };
}

export function signHash(wallet: ethers.Wallet, hash: string): string {
  const sig = wallet.signingKey.sign(hash);
  return ethers.Signature.from(sig).serialized;
}

// ─── 실습 진입점 ──────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S46: Gnosis Safe 2-of-3 — 다중 서명 키 거버넌스 ===\n');

  // ── [1] Safe 배포: threshold=2, 서명자 3명 ──────────────────────────────
  console.log('[검증 1] Gnosis Safe 배포 — threshold=2, 서명자 3명');

  const signerA = makeSigner();
  const signerB = makeSigner();
  const signerC = makeSigner();

  const safe = new SimulatedGnosisSafe({
    owners: [signerA.address, signerB.address, signerC.address],
    threshold: 2,
    chainId: 31337,
  });

  check('Safe 배포 완료 (address 생성)', /^0x[0-9a-f]{40}$/i.test(safe.address));
  check('소유자 수: 3명', safe.getOwners().length === 3);
  check('threshold: 2', safe.getThreshold() === 2);
  check('소유자 A 포함', safe.getOwners().includes(signerA.address));
  check('소유자 B 포함', safe.getOwners().includes(signerB.address));
  check('소유자 C 포함', safe.getOwners().includes(signerC.address));

  // ── [2] 단일 HOT 키 vs 2-of-3 보안 비교 ────────────────────────────────
  console.log('\n[검증 2] 단일 HOT 키 vs 2-of-3 — 보안 차이');

  const single = createSingleKeySystem();

  // 단일 키: 키 탈취 → 즉시 시스템 장악 가능
  const attackerWithStolen = single.hotKey; // 공격자가 HOT 키 탈취
  const attackResult = attackerWithStolen.signingKey.sign('0x' + 'de'.repeat(32));
  check('단일 키: 탈취된 키로 서명 가능 (위험)', ethers.Signature.from(attackResult) !== null);

  // 2-of-3: 서명자 A 키 탈취 → 단독으로 execTransaction 불가
  const txParams: SafeTxParams = {
    to: '0xKyoboNFTProxy00000000000000000000000000',
    value: 0n,
    data: '0x8456cb59', // pause() selector
    operation: 0,
  };
  const safeTxHash = safe.getTransactionHash(txParams);
  const sigAOnly = signHash(signerA.wallet, safeTxHash);

  let execWithOneKey = false;
  try {
    safe.execTransaction(txParams, [{ signer: signerA.address, signature: sigAOnly }]);
    execWithOneKey = true;
  } catch (err) {
    execWithOneKey = false;
    check('2-of-3: A 키 단독 실행 → GS020 revert', (err as Error).message.includes('GS020'));
  }
  check('2-of-3: 단일 키 탈취 시 실행 불가', !execWithOneKey);

  // ── [3] EIP-712 SafeTx 해시 계산 ────────────────────────────────────────
  console.log('\n[검증 3] EIP-712 SafeTx 해시 계산');

  const domainSep = safe.domainSeparator();
  check('domainSeparator: 32바이트 hex', /^0x[0-9a-f]{64}$/.test(domainSep));

  // 동일 파라미터 → 동일 해시 (결정론적)
  const hash1 = safe.getTransactionHash(txParams);
  const hash2 = safe.getTransactionHash(txParams);
  check('동일 파라미터 → 동일 해시 (결정론적)', hash1 === hash2);
  check('safeTxHash: 32바이트 hex', /^0x[0-9a-f]{64}$/.test(hash1));

  // chainId 변경 → domainSeparator 변경 → safeTxHash 변경 (재생 공격 방지)
  const safeMainnet = new SimulatedGnosisSafe({
    owners: [signerA.address, signerB.address, signerC.address],
    threshold: 2,
    chainId: 1, // mainnet
  });
  const mainnetHash = safeMainnet.getTransactionHash(txParams);
  check('chainId(1) vs chainId(31337) → 해시 다름 (재생 공격 방지)', hash1 !== mainnetHash);

  // ── [4] 2-of-3 서명 → execTransaction 성공 ──────────────────────────────
  console.log('\n[검증 4] 2-of-3 서명 → execTransaction 성공');

  const sigA = signHash(signerA.wallet, safeTxHash);
  const sigB = signHash(signerB.wallet, safeTxHash);

  // ecrecover 검증
  const recoveredA = safe.verifySignature(safeTxHash, sigA);
  const recoveredB = safe.verifySignature(safeTxHash, sigB);
  check('서명 A ecrecover → signerA 주소 복원', recoveredA.toLowerCase() === signerA.address.toLowerCase());
  check('서명 B ecrecover → signerB 주소 복원', recoveredB.toLowerCase() === signerB.address.toLowerCase());

  // 2-of-3 실행 성공
  const execResult = safe.execTransaction(txParams, [
    { signer: signerA.address, signature: sigA },
    { signer: signerB.address, signature: sigB },
  ]);
  check('2-of-3 서명 → execTransaction 성공', execResult.success);
  check('실행 결과: txHash 반환', /^0x[0-9a-f]{64}$/.test(execResult.txHash));
  check('nonce 증가 (재생 공격 방지)', safe.getNonce() === 1n);

  // ── [5] swapOwner — 서명자 교체 시나리오 ────────────────────────────────
  console.log('\n[검증 5] swapOwner — 서명자 B 탈퇴 → D로 교체');

  const signerD = makeSigner();
  const swapOwnerData = safe.buildSwapOwnerData(signerB.address, signerD.address);
  check('swapOwner calldata 생성', swapOwnerData.startsWith('0x'));

  // swapOwner TX도 2-of-3 필요 — A + C 서명으로 실행
  const swapTxParams: SafeTxParams = {
    to:        safe.address, // Safe 자체를 대상으로 self-call
    value:     0n,
    data:      swapOwnerData,
    operation: 0,
    nonce:     safe.getNonce(), // 현재 nonce
  };
  const swapTxHash = safe.getTransactionHash(swapTxParams);
  const sigASwap = signHash(signerA.wallet, swapTxHash);
  const sigCSwap = signHash(signerC.wallet, swapTxHash);

  // A + C로 실행 (B 부재 시나리오)
  const swapResult = safe.execTransaction(swapTxParams, [
    { signer: signerA.address, signature: sigASwap },
    { signer: signerC.address, signature: sigCSwap },
  ]);
  check('A + C 서명으로 swapOwner 실행 성공', swapResult.success);

  // 소유자 교체 적용
  safe.applySwapOwner(signerB.address, signerD.address);
  check('B → D 교체 후: D가 소유자 목록에 있음', safe.getOwners().includes(signerD.address));
  check('B는 소유자 목록에서 제거됨', !safe.getOwners().includes(signerB.address));
  check('소유자 수 유지: 여전히 3명', safe.getOwners().length === 3);

  // ─── 정리 ───────────────────────────────────────────────────────────────
  console.log('\n=== S46 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. 단일 HOT 키: 키 탈취 1회 → 컨트랙트 전체 제어 가능 → 금융 시스템 부적합');
  console.log('  2. 2-of-3: A 키 탈취되어도 B 또는 C 없이 execTransaction 불가 (GS020)');
  console.log('  3. EIP-712: domainSeparator에 chainId + Safe 주소 포함 → 체인/Safe 간 재생 공격 차단');
  console.log('  4. 오프체인 서명: 서명자들이 가스비 없이 서명 → 마지막 실행자만 가스 1회 납부');
  console.log('  5. swapOwner: 키 분실/퇴직 시 2-of-3로 소유자 교체 — 키 공유(임시 위임) 금지');
})();
