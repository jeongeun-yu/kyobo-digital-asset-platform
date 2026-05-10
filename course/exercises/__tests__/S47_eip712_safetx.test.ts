/**
 * S47 채점 — EIP-712 SafeTx 해시 수동 계산과 오프체인 서명 검증
 *
 * 채점 기준:
 *   · calcDomainSeparator: 결정론적, 32바이트 hex
 *   · calcStructHash: bytes 필드 keccak256 해시, 결정론적
 *   · calcSafeTxHash: 0x1901 prefix 포함
 *   · ecrecover 검증: 서명자 주소 복원
 *   · chainId 재생 공격 차단
 */

import { ethers } from 'ethers';
import {
  calcDomainSeparator,
  calcStructHash,
  calcSafeTxHash,
  signEip712Hash,
  SafeTxFields,
} from '../M8/S47_eip712_safetx';

// ─── 테스트 파라미터 ─────────────────────────────────────────────────────────

const SAFE_ADDRESS = ethers.getAddress('0x1234567890123456789012345678901234567890');
const CHAIN_ID     = 31337;
const KYOBO_NFT    = ethers.getAddress('0xabcdef0123456789abcdef0123456789abcdef01');

// ─── 테스트 픽스처 ───────────────────────────────────────────────────────────

const PAUSE_TX: SafeTxFields = {
  to: KYOBO_NFT, value: 0n, data: '0x8456cb59', operation: 0, nonce: 0n,
};

const UNPAUSE_TX: SafeTxFields = {
  to: KYOBO_NFT, value: 0n, data: '0x3f4ba83a', operation: 0, nonce: 0n,
};

// ─── 채점 테스트 ─────────────────────────────────────────────────────────────

describe('S47 채점 — EIP-712 SafeTx 해시 수동 계산', () => {

  describe('TODO: calcDomainSeparator 계산', () => {
    it('반환값: 32바이트 hex 형식', () => {
      const sep = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      expect(sep).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('동일 파라미터 → 동일 domainSeparator (결정론적)', () => {
      const sep1 = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const sep2 = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      expect(sep1).toBe(sep2);
    });

    it('chainId 다르면 domainSeparator 다름', () => {
      const mainnet = calcDomainSeparator(1,     SAFE_ADDRESS);
      const testnet = calcDomainSeparator(31337, SAFE_ADDRESS);
      expect(mainnet).not.toBe(testnet);
    });

    it('Safe 주소 다르면 domainSeparator 다름', () => {
      const addr1 = '0x1234567890123456789012345678901234567890';
      const addr2 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      expect(calcDomainSeparator(CHAIN_ID, addr1)).not.toBe(calcDomainSeparator(CHAIN_ID, addr2));
    });
  });

  describe('TODO: calcStructHash 계산', () => {
    it('반환값: 32바이트 hex 형식', () => {
      expect(calcStructHash(PAUSE_TX)).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('동일 파라미터 → 동일 structHash (결정론적)', () => {
      expect(calcStructHash(PAUSE_TX)).toBe(calcStructHash(PAUSE_TX));
    });

    it('data 다르면 structHash 다름 (bytes 필드 keccak256 해시)', () => {
      expect(calcStructHash(PAUSE_TX)).not.toBe(calcStructHash(UNPAUSE_TX));
    });

    it('nonce 다르면 structHash 다름', () => {
      const tx0 = { ...PAUSE_TX, nonce: 0n };
      const tx1 = { ...PAUSE_TX, nonce: 1n };
      expect(calcStructHash(tx0)).not.toBe(calcStructHash(tx1));
    });
  });

  describe('TODO: calcSafeTxHash 계산', () => {
    it('반환값: 32바이트 hex 형식', () => {
      const sep  = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const sh   = calcStructHash(PAUSE_TX);
      expect(calcSafeTxHash(sep, sh)).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('동일 파라미터 → 동일 safeTxHash (결정론적)', () => {
      const sep = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const sh  = calcStructHash(PAUSE_TX);
      expect(calcSafeTxHash(sep, sh)).toBe(calcSafeTxHash(sep, sh));
    });

    it('structHash 다르면 safeTxHash 다름', () => {
      const sep = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const sh1 = calcStructHash(PAUSE_TX);
      const sh2 = calcStructHash(UNPAUSE_TX);
      expect(calcSafeTxHash(sep, sh1)).not.toBe(calcSafeTxHash(sep, sh2));
    });
  });

  describe('TODO: ecrecover 검증 — 서명자 주소 복원', () => {
    it('개인키 서명값: 65바이트 hex (r+s+v)', () => {
      const wallet = ethers.Wallet.createRandom();
      const sep    = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const sh     = calcStructHash(PAUSE_TX);
      const hash   = calcSafeTxHash(sep, sh);
      const sig    = signEip712Hash(wallet, hash);
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    });

    it('ecrecover → 서명자 주소와 일치', () => {
      const wallet = ethers.Wallet.createRandom();
      const sep    = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const sh     = calcStructHash(PAUSE_TX);
      const hash   = calcSafeTxHash(sep, sh);
      const sig    = signEip712Hash(wallet, hash);
      const recovered = ethers.recoverAddress(hash, sig);
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    });

    it('다른 TX 해시로 ecrecover → 서명자 주소와 다름 (위조 감지)', () => {
      const wallet    = ethers.Wallet.createRandom();
      const sep       = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const correctSh = calcStructHash(PAUSE_TX);
      const wrongSh   = calcStructHash(UNPAUSE_TX);
      const correctHash = calcSafeTxHash(sep, correctSh);
      const wrongHash   = calcSafeTxHash(sep, wrongSh);
      const sig         = signEip712Hash(wallet, correctHash);
      const recovered   = ethers.recoverAddress(wrongHash, sig);
      expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
    });
  });

  describe('TODO: chainId 재생 공격 차단', () => {
    it('mainnet 서명을 testnet safeTxHash로 ecrecover → 서명자와 다름', () => {
      const wallet      = ethers.Wallet.createRandom();
      const mainnetSep  = calcDomainSeparator(1,     SAFE_ADDRESS);
      const testnetSep  = calcDomainSeparator(31337, SAFE_ADDRESS);
      const sh          = calcStructHash(PAUSE_TX);

      const mainnetHash  = calcSafeTxHash(mainnetSep, sh);
      const testnetHash  = calcSafeTxHash(testnetSep, sh);
      const mainnetSig   = signEip712Hash(wallet, mainnetHash);

      const recovered = ethers.recoverAddress(testnetHash, mainnetSig);
      expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
    });

    it('mainnet vs testnet safeTxHash 다름', () => {
      const sep1 = calcDomainSeparator(1,     SAFE_ADDRESS);
      const sep2 = calcDomainSeparator(31337, SAFE_ADDRESS);
      const sh   = calcStructHash(PAUSE_TX);
      expect(calcSafeTxHash(sep1, sh)).not.toBe(calcSafeTxHash(sep2, sh));
    });

    it('같은 체인, 다른 Safe 주소 → domainSeparator 다름', () => {
      const safe1 = '0x1234567890123456789012345678901234567890';
      const safe2 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      expect(calcDomainSeparator(CHAIN_ID, safe1)).not.toBe(calcDomainSeparator(CHAIN_ID, safe2));
    });
  });

  describe('2-of-2 SafeTx 생명주기 시뮬레이션', () => {
    it('[1단계] proposeTx: 해시 계산 → 32바이트', () => {
      const sep  = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const sh   = calcStructHash(PAUSE_TX);
      const hash = calcSafeTxHash(sep, sh);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('[2단계] A 서명 → ecrecover A 일치', () => {
      const walletA = ethers.Wallet.createRandom();
      const sep     = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const sh      = calcStructHash(PAUSE_TX);
      const hash    = calcSafeTxHash(sep, sh);
      const sigA    = signEip712Hash(walletA, hash);
      const recA    = ethers.recoverAddress(hash, sigA);
      expect(recA.toLowerCase()).toBe(walletA.address.toLowerCase());
    });

    it('[2단계] B 서명 → ecrecover B 일치', () => {
      const walletB = ethers.Wallet.createRandom();
      const sep     = calcDomainSeparator(CHAIN_ID, SAFE_ADDRESS);
      const sh      = calcStructHash(PAUSE_TX);
      const hash    = calcSafeTxHash(sep, sh);
      const sigB    = signEip712Hash(walletB, hash);
      const recB    = ethers.recoverAddress(hash, sigB);
      expect(recB.toLowerCase()).toBe(walletB.address.toLowerCase());
    });
  });
});
