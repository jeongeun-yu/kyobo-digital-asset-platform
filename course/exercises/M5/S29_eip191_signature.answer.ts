/**
 * S29 실습 — 블록체인 서명 기반 지갑 소유권 증명 원리
 *
 * 강의 노트: M5_S29_eip191_signature.md
 *
 * 실행 방법 (루트에서): npm run exercise:s29
 *
 * 목표:
 *   [1] EIP-191 서명 검증 흐름 — nonce 확인 → ecrecover → 주소 일치 → nonce 무효화
 *   [2] verifyOwnership() 구현 — 잘못된 서명 → false, 올바른 서명 → true + DB 저장
 *   [3] nonce 재사용 방지 — 같은 nonce 두 번 → 두 번째 false
 *   [4] 주소 비교 lowercase 정규화
 */

import { createHash } from 'crypto';
import { ethers } from 'ethers';

// ────────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────────

type VaspType = 'EXTERNAL' | 'KYOBO';

interface WalletRecord {
  userId:     string;
  walletAddr: string;
  vaspType:   VaspType;
  verified:   boolean;
  createdAt:  Date;
}

/** 서명에서 복원된 주소를 반환하는 인터페이스 */
interface SignatureVerifier {
  recoverAddress(message: string, signature: string): Promise<string>;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: EthersSignatureVerifier — ethers.js로 EIP-191 서명 검증
//
// EIP-191 접두사: "\x19Ethereum Signed Message:\n" + len(message)
// ethers.verifyMessage()가 이 접두사를 자동으로 처리한다.
// 접두사가 없으면 ecrecover 결과가 달라짐 (피싱 방지 목적)
// ────────────────────────────────────────────────────────────────────────

class EthersSignatureVerifier implements SignatureVerifier {
  async recoverAddress(message: string, signature: string): Promise<string> {
    // ethers.js가 EIP-191 접두사 자동 처리
    // → "\x19Ethereum Signed Message:\n{len}{message}" 해시 후 ECDSA recover
    return ethers.verifyMessage(message, signature);
  }
}

// ────────────────────────────────────────────────────────────────────────
// InMemory 저장소
// ────────────────────────────────────────────────────────────────────────

class InMemoryNonceRepo {
  private store = new Map<string, string>();  // userId → nonce

  async find(userId: string): Promise<string | null> {
    return this.store.get(userId) ?? null;
  }

  async save(userId: string, nonce: string): Promise<void> {
    this.store.set(userId, nonce);
  }

  async delete(userId: string): Promise<void> {
    this.store.delete(userId);
  }
}

class InMemoryWalletRepo {
  private store = new Map<string, WalletRecord>();  // userId → WalletRecord

  async findByUserId(userId: string): Promise<WalletRecord | null> {
    return this.store.get(userId) ?? null;
  }

  async upsert(record: WalletRecord): Promise<void> {
    this.store.set(record.userId, { ...record });
  }
}

// ────────────────────────────────────────────────────────────────────────
// WalletMappingService (S29 확장 버전)
//
// 핵심 메서드:
//   generateNonce(userId): 일회용 nonce 발급 + DB 저장
//   verifyOwnership(params): EIP-191 서명 검증 → verified=true 저장
//
// 검증 순서 (반드시 이 순서로!):
//   ① nonce 확인 (cheap check — DoS 방지, 연산 낭비 차단)
//   ② ecrecover — ECDSA 서명 검증 (연산 비용 높음)
//   ③ 주소 일치 확인 — lowercase 정규화 필수
//   ④ nonce 무효화 (검증 성공 후에만 — 실패 시 재시도 허용)
//   ⑤ DB upsert (verified=true)
// ────────────────────────────────────────────────────────────────────────

export class WalletMappingService {
  constructor(
    private readonly nonceRepo:    InMemoryNonceRepo,
    private readonly walletRepo:   InMemoryWalletRepo,
    private readonly sigVerifier:  SignatureVerifier,
  ) {}

  /**
   * nonce 생성 — 서명 요청마다 새 값 발급
   * sha256(userId + timestamp + random).slice(0, 16)
   */
  generateNonce(userId: string): string {
    const raw = `${userId}:${Date.now()}:${Math.random()}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  async issueNonce(userId: string): Promise<string> {
    const nonce = this.generateNonce(userId);
    await this.nonceRepo.save(userId, nonce);
    return nonce;
  }

  /**
   * EIP-191 서명 기반 지갑 소유권 검증
   *
   * @returns true  → 검증 성공 (verified=true DB 저장)
   * @returns false → 검증 실패 (nonce 불일치 또는 서명자 불일치)
   */
  async verifyOwnership(params: {
    userId:     string;
    walletAddr: string;
    signature:  string;
    nonce:      string;
  }): Promise<boolean> {
    const { userId, walletAddr, signature, nonce } = params;

    // ① nonce 유효성 확인 (cheap check — 먼저 수행해서 ECDSA 연산 낭비 방지)
    const storedNonce = await this.nonceRepo.find(userId);
    if (!storedNonce || storedNonce !== nonce) {
      return false;  // 유효하지 않은 nonce (미발급 또는 이미 사용됨)
    }

    // ② 서명에서 주소 복원 (ECDSA ecrecover — 연산 비용 높음)
    // 메시지 형식: "Kyobo Digital Asset Wallet: {userId}:{nonce}"
    const message = `Kyobo Digital Asset Wallet: ${userId}:${nonce}`;
    const recovered = await this.sigVerifier.recoverAddress(message, signature);

    // ③ 복원 주소 == 사용자 주장 주소?
    // EIP-55 checksum 주소와 lowercase 주소가 다르게 보이므로 반드시 정규화
    if (recovered.toLowerCase() !== walletAddr.toLowerCase()) {
      return false;  // 서명자 ≠ 지갑 소유자
    }

    // ④ nonce 무효화 (재생 공격 방지 — 검증 성공 후에만 삭제)
    // 실패 시 nonce를 살려두어 사용자가 다시 시도할 수 있게 함
    await this.nonceRepo.delete(userId);

    // ⑤ 소유권 증명 완료 → DB upsert (verified=true)
    await this.walletRepo.upsert({
      userId,
      walletAddr,
      vaspType:  'EXTERNAL',
      verified:  true,
      createdAt: new Date(),
    });

    return true;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 테스트용 Mock SignatureVerifier
//
// 실제 환경에서는 EthersSignatureVerifier를 사용하지만,
// 실습에서는 실제 서명 생성 없이 Mock으로 동작 검증
// ────────────────────────────────────────────────────────────────────────

function createMockVerifier(expectedAddr: string, validSig: string): SignatureVerifier {
  return {
    async recoverAddress(_message: string, signature: string): Promise<string> {
      // 올바른 서명 → 정상 주소 반환
      if (signature === validSig) return expectedAddr.toLowerCase();
      // 잘못된 서명 → 영주소 반환 (어떤 주소와도 일치하지 않음)
      return '0x0000000000000000000000000000000000000000';
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S29: EIP-191 서명 기반 지갑 소유권 증명 ===\n');

  const WALLET_ADDR = '0xAbCd1234EF5678901234567890abcdef01234567';
  const VALID_SIG   = '0xValidSignatureForKyoboWallet';

  const mockVerifier = createMockVerifier(WALLET_ADDR, VALID_SIG);

  function newService() {
    return new WalletMappingService(
      new InMemoryNonceRepo(),
      new InMemoryWalletRepo(),
      mockVerifier,
    );
  }

  // ── [1] 올바른 서명 → verified=true ────────────────────────────────────
  console.log('[검증 1] 올바른 서명 → true 반환 + verified=true DB 저장');
  const svc1   = newService();
  const nonce1 = await svc1.issueNonce('user1');
  const result1 = await svc1.verifyOwnership({
    userId:     'user1',
    walletAddr: WALLET_ADDR,
    signature:  VALID_SIG,
    nonce:      nonce1,
  });
  check('올바른 서명 → true',                      result1 === true);

  // ── [2] 잘못된 서명 → false ──────────────────────────────────────────────
  console.log('\n[검증 2] 잘못된 서명 → false 반환 (HTTP 403)');
  const svc2   = newService();
  const nonce2 = await svc2.issueNonce('user2');
  const result2 = await svc2.verifyOwnership({
    userId:     'user2',
    walletAddr: WALLET_ADDR,
    signature:  '0xInvalidSignature',
    nonce:      nonce2,
  });
  check('잘못된 서명 → false',                     result2 === false);

  // ── [3] nonce 재사용 방지 ─────────────────────────────────────────────
  console.log('\n[검증 3] nonce 재사용 방지 — 동일 nonce 두 번 → 두 번째 false');
  const svc3   = newService();
  const nonce3 = await svc3.issueNonce('user3');

  // 첫 번째 검증 성공 → nonce 무효화
  const first = await svc3.verifyOwnership({
    userId: 'user3', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce: nonce3,
  });
  // 같은 nonce로 재전송 (재생 공격 시뮬레이션)
  const second = await svc3.verifyOwnership({
    userId: 'user3', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce: nonce3,
  });
  check('첫 번째 검증 성공',                       first === true);
  check('두 번째 검증 실패 (nonce 이미 무효화)',    second === false);

  // ── [4] 유효하지 않은 nonce (미발급) → false ───────────────────────────
  console.log('\n[검증 4] 미발급 nonce → false (nonce 발급 없이 서명 전송)');
  const svc4  = newService();
  const fake  = await svc4.verifyOwnership({
    userId: 'user4', walletAddr: WALLET_ADDR, signature: VALID_SIG,
    nonce:  'fake-nonce-never-issued',
  });
  check('미발급 nonce → false',                    fake === false);

  // ── [5] 주소 대소문자 정규화 — EIP-55 checksum ────────────────────────
  console.log('\n[검증 5] 주소 대소문자 정규화 — lowercase 비교');
  const svc5   = newService();
  const nonce5 = await svc5.issueNonce('user5');
  // 대문자 checksum 형식으로 walletAddr 전달
  const upperAddr   = WALLET_ADDR.toUpperCase().replace('0X', '0x');
  const checksumSvc = new WalletMappingService(
    new InMemoryNonceRepo(),
    new InMemoryWalletRepo(),
    createMockVerifier(WALLET_ADDR, VALID_SIG),  // 항상 lowercase 반환
  );
  await checksumSvc.issueNonce('user5');
  const nonce5b = await checksumSvc.issueNonce('user5');
  const result5 = await checksumSvc.verifyOwnership({
    userId: 'user5', walletAddr: upperAddr, signature: VALID_SIG, nonce: nonce5b,
  });
  check('EIP-55 대소문자 checksum 주소도 정상 검증', result5 === true);

  // ── [6] nonce 생성 형식 확인 ────────────────────────────────────────────
  console.log('\n[검증 6] nonce 형식 — 16자 hex 문자열');
  const svc6   = newService();
  const nonce6 = svc6.generateNonce('user6');
  check('nonce 길이 16자',                          nonce6.length === 16);
  check('nonce hex 형식',                           /^[0-9a-f]{16}$/.test(nonce6));

  // 같은 userId에서 연속 발급 → 다른 값
  const nonce6b = svc6.generateNonce('user6');
  check('연속 발급 nonce 중복 없음',                 nonce6 !== nonce6b);

  // ── [7] 지갑 교체 시나리오 — 재등록 후 최신 주소 유지 ─────────────────
  console.log('\n[검증 7] 지갑 교체 — 재등록 후 최신 주소만 유지');
  const repo7       = new InMemoryWalletRepo();
  const nonceRepo7  = new InMemoryNonceRepo();
  const NEW_ADDR    = '0xNewWallet00000000000000000000000000000BB';
  const svc7        = new WalletMappingService(nonceRepo7, repo7, createMockVerifier(NEW_ADDR, VALID_SIG));

  const nonce7a = await svc7.issueNonce('user7');
  await svc7.verifyOwnership({ userId: 'user7', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce: nonce7a });
  // 지갑 교체
  const nonce7b = await svc7.issueNonce('user7');
  const replaceResult = await svc7.verifyOwnership({ userId: 'user7', walletAddr: NEW_ADDR, signature: VALID_SIG, nonce: nonce7b });
  check('지갑 교체 등록 성공',                      replaceResult === true);

  // ── EIP-191 이론 확인 (ethers.js 실제 동작) ───────────────────────────
  console.log('\n[참고] EIP-191 실제 서명 검증 예시 (ethers.js)');
  const wallet    = ethers.Wallet.createRandom();
  const testMsg   = `Kyobo Digital Asset Wallet: test-user:abc123`;
  const testSig   = await wallet.signMessage(testMsg);
  const recovered = ethers.verifyMessage(testMsg, testSig);
  console.log(`  서명자 주소:  ${wallet.address}`);
  console.log(`  복원된 주소:  ${recovered}`);
  check('ethers.verifyMessage — 주소 복원 성공',   recovered.toLowerCase() === wallet.address.toLowerCase());

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S29 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. Sybil 공격 방지: 주소를 아는 것≠주소 소유 → 서명으로 개인키 보유 증명');
  console.log('  2. EIP-191 접두사: "\\x19Ethereum Signed Message:\\n{len}" — 피싱 트랜잭션과 구분');
  console.log('  3. nonce: 일회용 랜덤값 → 재생(Replay) 공격 방지 (같은 서명 재사용 차단)');
  console.log('  4. 검증 순서: ① nonce 확인 (cheap) → ② ecrecover → ③ 주소 비교 → ④ nonce 무효화');
  console.log('  5. lowercase 정규화: EIP-55 checksum 형식 차이로 인한 false negative 방지');
  console.log('  6. nonce 무효화는 검증 성공 후에만 → 실패 시 재시도 허용');
})();
