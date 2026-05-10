/**
 * S46 채점 — 다중 서명 기반 키 거버넌스: Gnosis Safe 2-of-3 구조 시뮬레이션
 *
 * 채점 기준:
 *   · domainSeparator / structHash / safeTxHash 계산 (결정론적)
 *   · 2-of-3 execTransaction 성공
 *   · 1-of-3(단독) execTransaction → GS020 에러
 *   · chainId 변경 시 domainSeparator 달라짐 (재생 공격 방지)
 */

import { ethers } from 'ethers';
import {
  SimulatedGnosisSafe,
  SafeTxParams,
  SafeConfig,
  makeSigner,
  signHash,
} from '../M8/S46_gnosis_safe';

// ─── 공통 픽스처 ─────────────────────────────────────────────────────────────

const BASE_TX_PARAMS: SafeTxParams = {
  to: '0x1234567890123456789012345678901234567890', // EIP-55 all-lowercase is always valid
  value: 0n,
  data: '0x8456cb59', // pause()
  operation: 0,
};

function makeSigners() {
  return { signerA: makeSigner(), signerB: makeSigner(), signerC: makeSigner() };
}

function makeSafe(signerA: { address: string }, signerB: { address: string }, signerC: { address: string }, chainId = 31337) {
  return new SimulatedGnosisSafe({
    owners: [signerA.address, signerB.address, signerC.address],
    threshold: 2,
    chainId,
  });
}

// ─── 채점 테스트 ─────────────────────────────────────────────────────────────

describe('S46 채점 — Gnosis Safe 2-of-3', () => {

  describe('TODO: domainSeparator / structHash / safeTxHash 계산', () => {
    it('domainSeparator: 32바이트 hex 형식', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      expect(safe.domainSeparator()).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('동일 파라미터 → 동일 domainSeparator (결정론적)', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      expect(safe.domainSeparator()).toBe(safe.domainSeparator());
    });

    it('safeTxHash: 32바이트 hex 형식', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      expect(safe.getTransactionHash(BASE_TX_PARAMS)).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('동일 TX 파라미터 → 동일 safeTxHash (결정론적)', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      const hash1 = safe.getTransactionHash(BASE_TX_PARAMS);
      const hash2 = safe.getTransactionHash(BASE_TX_PARAMS);
      expect(hash1).toBe(hash2);
    });

    it('chainId(1) vs chainId(31337) → safeTxHash 다름 (재생 공격 방지)', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safeLocal   = makeSafe(signerA, signerB, signerC, 31337);
      const safeMainnet = makeSafe(signerA, signerB, signerC, 1);
      expect(safeLocal.getTransactionHash(BASE_TX_PARAMS)).not.toBe(safeMainnet.getTransactionHash(BASE_TX_PARAMS));
    });
  });

  describe('TODO: 2-of-3 execTransaction 성공', () => {
    it('A + B 서명 → execTransaction success: true', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      const txHash = safe.getTransactionHash(BASE_TX_PARAMS);
      const sigA = signHash(signerA.wallet, txHash);
      const sigB = signHash(signerB.wallet, txHash);
      const result = safe.execTransaction(BASE_TX_PARAMS, [
        { signer: signerA.address, signature: sigA },
        { signer: signerB.address, signature: sigB },
      ]);
      expect(result.success).toBe(true);
    });

    it('2-of-3 실행 후 nonce 증가 (재생 공격 방지)', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      const txHash = safe.getTransactionHash(BASE_TX_PARAMS);
      const sigA = signHash(signerA.wallet, txHash);
      const sigB = signHash(signerB.wallet, txHash);
      safe.execTransaction(BASE_TX_PARAMS, [
        { signer: signerA.address, signature: sigA },
        { signer: signerB.address, signature: sigB },
      ]);
      expect(safe.getNonce()).toBe(1n);
    });

    it('실행 결과: txHash 32바이트 hex', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      const txHash = safe.getTransactionHash(BASE_TX_PARAMS);
      const sigA = signHash(signerA.wallet, txHash);
      const sigB = signHash(signerB.wallet, txHash);
      const result = safe.execTransaction(BASE_TX_PARAMS, [
        { signer: signerA.address, signature: sigA },
        { signer: signerB.address, signature: sigB },
      ]);
      expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('ecrecover: signerA 서명 → A 주소 복원', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      const txHash = safe.getTransactionHash(BASE_TX_PARAMS);
      const sigA = signHash(signerA.wallet, txHash);
      expect(safe.verifySignature(txHash, sigA).toLowerCase()).toBe(signerA.address.toLowerCase());
    });

    it('ecrecover: signerB 서명 → B 주소 복원', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      const txHash = safe.getTransactionHash(BASE_TX_PARAMS);
      const sigB = signHash(signerB.wallet, txHash);
      expect(safe.verifySignature(txHash, sigB).toLowerCase()).toBe(signerB.address.toLowerCase());
    });
  });

  describe('TODO: 단독 서명으로 실행 불가 (GS020)', () => {
    it('A 키 단독 서명 → GS020 에러 발생', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      const txHash = safe.getTransactionHash(BASE_TX_PARAMS);
      const sigA = signHash(signerA.wallet, txHash);
      expect(() =>
        safe.execTransaction(BASE_TX_PARAMS, [{ signer: signerA.address, signature: sigA }]),
      ).toThrow(/GS020/);
    });

    it('서명 0개 → GS020 에러 발생', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      expect(() => safe.execTransaction(BASE_TX_PARAMS, [])).toThrow(/GS020/);
    });

    it('1-of-3 차단 시 nonce 변화 없음', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      const txHash = safe.getTransactionHash(BASE_TX_PARAMS);
      const sigA = signHash(signerA.wallet, txHash);
      try {
        safe.execTransaction(BASE_TX_PARAMS, [{ signer: signerA.address, signature: sigA }]);
      } catch { /* expected */ }
      expect(safe.getNonce()).toBe(0n);
    });
  });

  describe('Safe 배포 — threshold=2, 서명자 3명', () => {
    it('Safe address: 0x로 시작하는 hex', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      expect(safe.address).toMatch(/^0x[0-9a-f]+/i);
    });

    it('소유자 수: 3명', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      expect(safe.getOwners()).toHaveLength(3);
    });

    it('threshold: 2', () => {
      const { signerA, signerB, signerC } = makeSigners();
      const safe = makeSafe(signerA, signerB, signerC);
      expect(safe.getThreshold()).toBe(2);
    });

    it('threshold > owners 수 → 생성 에러', () => {
      const { signerA, signerB } = makeSigners();
      expect(() => new SimulatedGnosisSafe({
        owners: [signerA.address, signerB.address],
        threshold: 3,
        chainId: 31337,
      })).toThrow();
    });
  });
});
