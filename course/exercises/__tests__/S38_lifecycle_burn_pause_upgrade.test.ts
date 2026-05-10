/**
 * S38 채점 — 컨트랙트 생명주기 · 소각·일시정지·업그레이드
 *
 * 검증 항목:
 *   [1] ACTIVE ↔ PAUSED 상태 전이
 *   [2] PAUSED 상태에서 mint 거부
 *   [3] burn 잔액 감소
 *   [4] PAUSED 상태에서 burn 거부 (정책 A)
 *   [5] PAUSED 상태에서 burn 허용 (정책 B)
 *   [6] 업그레이드 권한 (UPGRADER_ROLE)
 *   [7] 생명주기 전체 흐름: ACTIVE → PAUSED → ACTIVE → UPGRADED
 */

import {
  KyoboNFTLifecycle,
  encodeTokenId,
} from '../M6/S38_lifecycle_burn_pause_upgrade';

// ── 테스트 ───────────────────────────────────────────────────────────────────

describe('S38 채점 — 컨트랙트 생명주기 · 소각·일시정지·업그레이드', () => {
  const ADMIN    = '0xAdmin';
  const MINTER   = '0xMinter';
  const ATTACKER = '0xAttacker';
  const USER     = '0xUser';
  const tokenId  = encodeTokenId(1n, 1n);

  describe('[1] ACTIVE ↔ PAUSED 상태 전이', () => {
    it('TODO: 초기 state는 ACTIVE이다', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      expect(nft.getState()).toBe('ACTIVE');
    });

    it('TODO: pause() → state가 PAUSED로 전환된다', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      nft.pause(ADMIN);
      expect(nft.getState()).toBe('PAUSED');
    });

    it('TODO: unpause() → state가 ACTIVE로 복귀한다', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      nft.pause(ADMIN);
      nft.unpause(ADMIN);
      expect(nft.getState()).toBe('ACTIVE');
    });

    it('TODO: PAUSER_ROLE 없는 주소가 pause 시도 → AccessControlUnauthorizedAccount', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      expect(() => nft.pause(ATTACKER)).toThrow('AccessControlUnauthorizedAccount');
    });

    it('TODO: PAUSER_ROLE 없는 주소 pause 시도 후 state = ACTIVE 유지', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      try { nft.pause(ATTACKER); } catch { /* expected */ }
      expect(nft.getState()).toBe('ACTIVE');
    });
  });

  describe('[2] PAUSED 상태에서 mint 거부 (정책 A)', () => {
    it('TODO: Pause 상태에서 mint → EnforcedPause revert', () => {
      const nft = new KyoboNFTLifecycle(ADMIN, false);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.pause(ADMIN);
      expect(() => nft.mint(MINTER, USER, tokenId, 1n)).toThrow('EnforcedPause');
    });

    it('TODO: Pause 상태에서 transfer → EnforcedPause revert', () => {
      const nft = new KyoboNFTLifecycle(ADMIN, false);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.mint(MINTER, USER, tokenId, 5n);
      nft.pause(ADMIN);
      expect(() => nft.transfer(USER, ATTACKER, tokenId, 1n)).toThrow('EnforcedPause');
    });

    it('TODO: unpause 후 mint 정상 동작한다', () => {
      const nft = new KyoboNFTLifecycle(ADMIN, false);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.mint(MINTER, USER, tokenId, 5n);
      nft.pause(ADMIN);
      nft.unpause(ADMIN);
      nft.mint(MINTER, USER, tokenId, 1n);
      expect(nft.balanceOf(USER, tokenId)).toBe(6n);
    });
  });

  describe('[3] burn — 잔액 감소 확인', () => {
    it('TODO: mint 후 잔액 = 5', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.mint(MINTER, USER, tokenId, 5n);
      expect(nft.balanceOf(USER, tokenId)).toBe(5n);
    });

    it('TODO: burn(3) 후 잔액 = 2', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.mint(MINTER, USER, tokenId, 5n);
      nft.burn(MINTER, USER, tokenId, 3n);
      expect(nft.balanceOf(USER, tokenId)).toBe(2n);
    });

    it('TODO: 전량 burn 후 잔액 = 0', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.mint(MINTER, USER, tokenId, 5n);
      nft.burn(MINTER, USER, tokenId, 5n);
      expect(nft.balanceOf(USER, tokenId)).toBe(0n);
    });

    it('TODO: MINTER_ROLE 없는 주소 burn 시도 → AccessControlUnauthorizedAccount', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.mint(MINTER, USER, tokenId, 5n);
      expect(() => nft.burn(ATTACKER, USER, tokenId, 1n))
        .toThrow('AccessControlUnauthorizedAccount');
    });
  });

  describe('[4] PAUSED 상태에서 burn 거부 (정책 A: burnPauseExempt=false)', () => {
    it('TODO: 정책 A: Pause 상태 burn → EnforcedPause revert', () => {
      const nft = new KyoboNFTLifecycle(ADMIN, false);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.mint(MINTER, USER, tokenId, 5n);
      nft.pause(ADMIN);
      expect(() => nft.burn(MINTER, USER, tokenId, 1n)).toThrow('EnforcedPause');
    });
  });

  describe('[5] PAUSED 상태에서 burn 허용 (정책 B: burnPauseExempt=true)', () => {
    it('TODO: 정책 B: Pause 중 burn 성공 — 피해 NFT 즉시 회수 가능', () => {
      const nft = new KyoboNFTLifecycle(ADMIN, true);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.mint(MINTER, USER, tokenId, 5n);
      nft.pause(ADMIN);
      nft.burn(MINTER, USER, tokenId, 2n);
      expect(nft.balanceOf(USER, tokenId)).toBe(3n);
    });

    it('TODO: 정책 B: Pause 중 mint는 여전히 차단된다', () => {
      const nft = new KyoboNFTLifecycle(ADMIN, true);
      nft.grantRole('MINTER_ROLE', MINTER);
      nft.pause(ADMIN);
      expect(() => nft.mint(MINTER, USER, tokenId, 1n)).toThrow('EnforcedPause');
    });
  });

  describe('[6] 업그레이드 권한 (UPGRADER_ROLE)', () => {
    it('TODO: UPGRADER_ROLE 없는 주소 업그레이드 시도 → AccessControlUnauthorizedAccount', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      expect(() => nft.authorizeUpgrade(ATTACKER, '0xNewImpl'))
        .toThrow('AccessControlUnauthorizedAccount');
    });

    it('TODO: UPGRADER_ROLE 없는 주소 업그레이드 시도 후 state = ACTIVE 유지', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      try { nft.authorizeUpgrade(ATTACKER, '0xNewImpl'); } catch { /* expected */ }
      expect(nft.getState()).toBe('ACTIVE');
    });

    it('TODO: ADMIN(UPGRADER_ROLE 보유)은 upgrade 완료 → state = UPGRADED', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      nft.authorizeUpgrade(ADMIN, '0xNewImpl');
      expect(nft.getState()).toBe('UPGRADED');
    });
  });

  describe('[7] 생명주기 전체 흐름: ACTIVE → PAUSED → ACTIVE → UPGRADED', () => {
    it('TODO: ACTIVE → PAUSED → ACTIVE → UPGRADED 순서로 전환된다', () => {
      const nft = new KyoboNFTLifecycle(ADMIN);
      expect(nft.getState()).toBe('ACTIVE');

      nft.pause(ADMIN);
      expect(nft.getState()).toBe('PAUSED');

      nft.unpause(ADMIN);
      expect(nft.getState()).toBe('ACTIVE');

      nft.authorizeUpgrade(ADMIN, '0xV2');
      expect(nft.getState()).toBe('UPGRADED');
    });
  });
});
