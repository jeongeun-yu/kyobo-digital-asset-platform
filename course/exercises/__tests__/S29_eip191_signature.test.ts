/**
 * S29 채점 — EIP-191 서명 기반 지갑 소유권 증명
 *
 * 채점 기준:
 *   · nonce 발급/무효화 흐름
 *   · 올바른 서명 → true, 잘못된 서명 → false
 *   · lowercase 정규화 — EIP-55 checksum 주소도 정상 처리
 *   · nonce 재사용 → 두 번째 false (재생 공격 방지)
 *   · 미발급 nonce → false
 */

import { WalletMappingService } from '../M5/S29_eip191_signature';

// ── Mock SignatureVerifier ─────────────────────────────────────────────────────

function createMockVerifier(expectedAddr: string, validSig: string) {
  return {
    async recoverAddress(_message: string, signature: string): Promise<string> {
      if (signature === validSig) return expectedAddr.toLowerCase();
      return '0x0000000000000000000000000000000000000000';
    },
  };
}

// ── InMemory 저장소 재현 ─────────────────────────────────────────────────────

class TestNonceRepo {
  private store = new Map<string, string>();
  async find(userId: string): Promise<string | null> { return this.store.get(userId) ?? null; }
  async save(userId: string, nonce: string): Promise<void> { this.store.set(userId, nonce); }
  async delete(userId: string): Promise<void> { this.store.delete(userId); }
}

class TestWalletRepo {
  private store = new Map<string, { userId: string; walletAddr: string; vaspType: string; verified: boolean; createdAt: Date }>();
  async findByUserId(userId: string) { return this.store.get(userId) ?? null; }
  async upsert(record: { userId: string; walletAddr: string; vaspType: string; verified: boolean; createdAt: Date }): Promise<void> {
    this.store.set(record.userId, { ...record });
  }
}

const WALLET_ADDR = '0xAbCd1234EF5678901234567890abcdef01234567';
const VALID_SIG   = '0xValidSignatureForKyoboWallet';

function newService(expectedAddr = WALLET_ADDR, validSig = VALID_SIG) {
  return new WalletMappingService(
    new TestNonceRepo() as any,
    new TestWalletRepo() as any,
    createMockVerifier(expectedAddr, validSig) as any,
  );
}

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S29 채점 — EIP-191 서명 기반 지갑 소유권 증명', () => {

  describe('[1] 올바른 서명 → true 반환', () => {
    it('TODO: 올바른 서명 → verifyOwnership() true 반환', async () => {
      const svc   = newService();
      const nonce = await svc.issueNonce('user1');
      const result = await svc.verifyOwnership({
        userId: 'user1', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce,
      });
      expect(result).toBe(true);
    });

    it('TODO: 서명 성공 후 nonce가 무효화됨 (재사용 시 false)', async () => {
      const svc   = newService();
      const nonce = await svc.issueNonce('user1');
      await svc.verifyOwnership({ userId: 'user1', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce });
      const second = await svc.verifyOwnership({ userId: 'user1', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce });
      expect(second).toBe(false);
    });
  });

  describe('[2] 잘못된 서명 → false 반환', () => {
    it('TODO: 잘못된 서명 → verifyOwnership() false 반환', async () => {
      const svc   = newService();
      const nonce = await svc.issueNonce('user2');
      const result = await svc.verifyOwnership({
        userId: 'user2', walletAddr: WALLET_ADDR, signature: '0xInvalidSignature', nonce,
      });
      expect(result).toBe(false);
    });

    it('TODO: 잘못된 서명 후에도 nonce가 유지됨 (재시도 허용)', async () => {
      const svc   = newService();
      const nonce = await svc.issueNonce('user2');
      await svc.verifyOwnership({ userId: 'user2', walletAddr: WALLET_ADDR, signature: '0xInvalidSig', nonce });
      // 올바른 서명으로 재시도
      const retry = await svc.verifyOwnership({ userId: 'user2', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce });
      expect(retry).toBe(true);
    });
  });

  describe('[3] nonce 재사용 방지', () => {
    it('TODO: 첫 번째 검증 성공 → true', async () => {
      const svc   = newService();
      const nonce = await svc.issueNonce('user3');
      const first = await svc.verifyOwnership({ userId: 'user3', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce });
      expect(first).toBe(true);
    });

    it('TODO: 동일 nonce로 두 번 → 두 번째는 false', async () => {
      const svc   = newService();
      const nonce = await svc.issueNonce('user3');
      await svc.verifyOwnership({ userId: 'user3', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce });
      const second = await svc.verifyOwnership({ userId: 'user3', walletAddr: WALLET_ADDR, signature: VALID_SIG, nonce });
      expect(second).toBe(false);
    });
  });

  describe('[4] lowercase 정규화 — EIP-55 checksum 주소', () => {
    it('TODO: 대소문자 혼합 checksum 주소도 정상 검증', async () => {
      const svc        = newService();
      const nonce      = await svc.issueNonce('user5');
      const upperAddr  = WALLET_ADDR.toUpperCase().replace('0X', '0x');
      const result = await svc.verifyOwnership({
        userId: 'user5', walletAddr: upperAddr, signature: VALID_SIG, nonce,
      });
      expect(result).toBe(true);
    });

    it('TODO: 완전 소문자 주소도 정상 검증', async () => {
      const svc        = newService();
      const nonce      = await svc.issueNonce('user5b');
      const lowerAddr  = WALLET_ADDR.toLowerCase();
      const result = await svc.verifyOwnership({
        userId: 'user5b', walletAddr: lowerAddr, signature: VALID_SIG, nonce,
      });
      expect(result).toBe(true);
    });
  });

  describe('[5] 미발급 nonce → false', () => {
    it('TODO: nonce 발급 없이 서명 전송 → false', async () => {
      const svc  = newService();
      const fake = await svc.verifyOwnership({
        userId: 'user4', walletAddr: WALLET_ADDR, signature: VALID_SIG,
        nonce:  'fake-nonce-never-issued',
      });
      expect(fake).toBe(false);
    });

    it('TODO: 미발급 nonce → ECDSA 연산 없이 차단 (false 반환)', async () => {
      const svc = newService();
      // nonce 없이 → false (cheap check 통과 안 됨)
      const result = await svc.verifyOwnership({
        userId: 'user4', walletAddr: WALLET_ADDR, signature: VALID_SIG,
        nonce:  'totally-wrong-nonce',
      });
      expect(result).toBe(false);
    });
  });

  describe('[6] nonce 형식 — 16자 hex 문자열', () => {
    it('TODO: generateNonce 길이 16자', () => {
      const svc   = newService();
      const nonce = svc.generateNonce('user6');
      expect(nonce.length).toBe(16);
    });

    it('TODO: generateNonce hex 형식 (/^[0-9a-f]{16}$/)', () => {
      const svc   = newService();
      const nonce = svc.generateNonce('user6');
      expect(/^[0-9a-f]{16}$/.test(nonce)).toBe(true);
    });

    it('TODO: 연속 발급 nonce는 중복되지 않는다', () => {
      const svc    = newService();
      const nonce1 = svc.generateNonce('user6');
      const nonce2 = svc.generateNonce('user6');
      expect(nonce1).not.toBe(nonce2);
    });
  });
});
