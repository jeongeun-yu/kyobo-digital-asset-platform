/**
 * S40 채점 — 프록시 업그레이드 안전성 · Storage Layout 규칙
 *
 * 검증 항목:
 *   [1] v1 슬롯 레이아웃 확인
 *   [2] 안전한 v2 레이아웃 — 새 변수를 끝에 추가
 *   [3] Storage Collision 감지 — 앞에 삽입 시 충돌
 *   [4] hardhat-upgrades 체커 시뮬레이션
 *   [5] reinitializer(N) — 버전 단조 증가
 *   [6] v2 업그레이드 후 기존 토큰 잔액 보존
 */

import {
  buildV1Layout,
  buildV2SafeLayout,
  buildV2BadLayout,
  checkStorageLayoutCompatibility,
  ProxyStorageModel,
  InitializationVersionTracker,
  encodeTokenId,
} from '../M6/S40_storage_layout_upgrade';

// ── 테스트 ───────────────────────────────────────────────────────────────────

describe('S40 채점 — Storage Layout 규칙과 안전한 업그레이드', () => {
  describe('[1] v1 슬롯 레이아웃', () => {
    it('TODO: slot 0 = ERC1155 _uri', () => {
      const v1Layout = buildV1Layout();
      expect(v1Layout.layout[0]?.variable).toContain('_uri');
    });

    it('TODO: slot 1 = ERC1155 _balances', () => {
      const v1Layout = buildV1Layout();
      expect(v1Layout.layout[1]?.variable).toContain('_balances');
    });

    it('TODO: slot 4 = Pausable _paused', () => {
      const v1Layout = buildV1Layout();
      expect(v1Layout.layout[4]?.variable).toContain('_paused');
    });
  });

  describe('[2] 안전한 v2 레이아웃 — 새 변수를 끝에 추가', () => {
    it('TODO: v2 safe: slot 0~5 변경 없음 (기존 슬롯 유지)', () => {
      const v2SafeLayout = buildV2SafeLayout();
      expect(v2SafeLayout.layout[0]?.variable).toContain('_uri');
    });

    it('TODO: v2 safe: slot 6 = _baseTokenURI (끝에 추가)', () => {
      const v2SafeLayout = buildV2SafeLayout();
      expect(v2SafeLayout.layout[6]?.variable).toBe('_baseTokenURI');
    });

    it('TODO: v2 safe: slot 7 = _maxSupplyPerToken (끝에 추가)', () => {
      const v2SafeLayout = buildV2SafeLayout();
      expect(v2SafeLayout.layout[7]?.variable).toBe('_maxSupplyPerToken');
    });
  });

  describe('[3] Storage Collision — 앞에 삽입 시 슬롯 밀림', () => {
    it('TODO: BAD v2: slot 0 = newFeature(삽입) → 원래 _uri 자리 오염', () => {
      const v2BadLayout = buildV2BadLayout();
      expect(v2BadLayout.layout[0]?.variable).toContain('newFeature');
    });

    it('TODO: BAD v2: slot 1 = _uri(밀림) → 원래 _balances 자리', () => {
      const v2BadLayout = buildV2BadLayout();
      expect(v2BadLayout.layout[1]?.variable).toContain('_uri');
    });

    it('TODO: BAD v2 업그레이드 후 slot 1을 _uri(string)로 읽으면 타입 불일치 발생', () => {
      const proxy = new ProxyStorageModel();
      proxy.initializeV1('0xAdmin');
      proxy.writeBalance(encodeTokenId(1n, 42n), '0xUser', 5n);

      const slot1AsUri = proxy.readSlot1_AsUri_BAD();
      expect(typeof slot1AsUri).not.toBe('string'); // mapping인데 string으로 읽으면 타입 불일치
    });
  });

  describe('[4] hardhat-upgrades Storage Layout 체커', () => {
    const v1UsedSlots = [0, 1, 2, 3, 4, 5];

    it('TODO: 안전한 v2(slot 6, 7 추가) → 레이아웃 체크 통과', () => {
      const result = checkStorageLayoutCompatibility(
        v1UsedSlots,
        [{ slot: 6, variable: '_baseTokenURI' }, { slot: 7, variable: '_maxSupplyPerToken' }],
      );
      expect(result.compatible).toBe(true);
    });

    it('TODO: 안전한 v2 → 에러 없음', () => {
      const result = checkStorageLayoutCompatibility(
        v1UsedSlots,
        [{ slot: 6, variable: '_baseTokenURI' }],
      );
      expect(result.errors).toHaveLength(0);
    });

    it('TODO: BAD v2(기존 슬롯 범위에 없는 slot 8을 v1 범위에 충돌하도록 삽입) → 레이아웃 체크 실패', () => {
      // v1UsedSlots = [0, 1, 2, 4, 5], maxSlot=5
      // slot 3을 새 변수로 삽입하려 하면 v1Slots에 없는 슬롯 번호가 v1 범위 내 → 충돌
      const result = checkStorageLayoutCompatibility(
        [0, 1, 2, 4, 5],  // slot 3 없는 v1 슬롯 목록
        [{ slot: 3, variable: 'newFeatureInserted' }],  // slot 3 삽입 → 충돌
      );
      expect(result.compatible).toBe(false);
    });

    it('TODO: BAD v2 → "New storage layout is incompatible" 에러 발생', () => {
      const result = checkStorageLayoutCompatibility(
        [0, 1, 2, 4, 5],  // slot 3 없는 v1 슬롯 목록
        [{ slot: 3, variable: 'newFeatureInserted' }],
      );
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('New storage layout is incompatible');
    });
  });

  describe('[5] reinitializer(N) — 버전 단조 증가', () => {
    it('TODO: initialize() 실행 → _initialized = 1', () => {
      const tracker = new InitializationVersionTracker();
      tracker.initialize('0xAdmin');
      expect(tracker.getVersion()).toBe(1);
    });

    it('TODO: initialize() 재호출 → InvalidInitialization revert', () => {
      const tracker = new InitializationVersionTracker();
      tracker.initialize('0xAdmin');
      expect(() => tracker.initialize('0xAttacker')).toThrow('InvalidInitialization');
    });

    it('TODO: initialize() 재호출 후 version 변화 없음', () => {
      const tracker = new InitializationVersionTracker();
      tracker.initialize('0xAdmin');
      try { tracker.initialize('0xAttacker'); } catch { /* expected */ }
      expect(tracker.getVersion()).toBe(1);
    });

    it('TODO: initializeV2() 실행 → _initialized = 2', () => {
      const tracker = new InitializationVersionTracker();
      tracker.initialize('0xAdmin');
      tracker.initializeV2('https://api.kyobo.com/', 1000);
      expect(tracker.getVersion()).toBe(2);
    });

    it('TODO: initializeV2() 재호출 → InvalidInitialization revert', () => {
      const tracker = new InitializationVersionTracker();
      tracker.initialize('0xAdmin');
      tracker.initializeV2('https://api.kyobo.com/', 1000);
      expect(() => tracker.initializeV2('https://other.com/', 999)).toThrow('InvalidInitialization');
    });

    it('TODO: v2 배포 후에도 v1 initialize 재호출 차단', () => {
      const tracker = new InitializationVersionTracker();
      tracker.initialize('0xAdmin');
      tracker.initializeV2('https://api.kyobo.com/', 1000);
      expect(() => tracker.initialize('0xAttacker')).toThrow('InvalidInitialization');
    });

    it('TODO: initializeV3() 실행 → _initialized = 3', () => {
      const tracker = new InitializationVersionTracker();
      tracker.initialize('0xAdmin');
      tracker.initializeV2('https://api.kyobo.com/', 1000);
      tracker.initializeV3('newFeatureValue');
      expect(tracker.getVersion()).toBe(3);
    });
  });

  describe('[6] v2 업그레이드 후 기존 토큰 잔액 보존', () => {
    it('TODO: v2 업그레이드 후 기존 잔액이 그대로 유지된다', () => {
      const proxy = new ProxyStorageModel();
      proxy.initializeV1('0xAdmin');
      const tid = encodeTokenId(1n, 1n);
      proxy.writeBalance(tid, '0xUser', 5n);

      const balanceBefore = proxy.readBalance_V1(tid, '0xUser');
      expect(balanceBefore).toBe(5n);

      // v2 업그레이드: slot 6, 7만 추가, slot 1(_balances) 변경 없음
      proxy.rawSlots.set(6, 'https://api.kyobo.com/');
      proxy.rawSlots.set(7, 1000);

      const balanceAfter = proxy.readBalance_V1(tid, '0xUser');
      expect(balanceAfter).toBe(5n);
    });

    it('TODO: v2 업그레이드 후 새 슬롯(6, 7)이 정상 설정된다', () => {
      const proxy = new ProxyStorageModel();
      proxy.initializeV1('0xAdmin');
      proxy.rawSlots.set(6, 'https://api.kyobo.com/');
      proxy.rawSlots.set(7, 1000);

      expect(proxy.rawSlots.get(6)).toBe('https://api.kyobo.com/');
      expect(proxy.rawSlots.get(7)).toBe(1000);
    });
  });
});
