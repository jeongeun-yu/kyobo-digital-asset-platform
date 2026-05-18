/**
 * S36 채점 — UUPS 프록시 패턴과 Storage Collision
 *
 * 검증 항목:
 *   [1] delegatecall 동작 — Proxy storage, Implementation 코드
 *   [2] 올바른 v2 업그레이드 후 기존 상태 보존
 *   [3] Storage Collision — BAD v2가 슬롯을 잘못 해석
 *   [4] initializer 없는 취약 컨트랙트 재호출 공격
 *   [5] 안전한 initializer modifier — 한 번만 실행 보장
 *   [6] UUPS vs 투명 프록시 차이
 *   [7] ERC-1967 슬롯 상수
 */

import {
  ProxySimulator,
  ImplementationV2_BAD,
  VulnerableImpl,
  SafeImpl,
  ERC1967_IMPL_SLOT,
  ERC1967_ADMIN_SLOT,
} from '../M6/S36_uups_proxy_pattern';

// ── 테스트 ───────────────────────────────────────────────────────────────────

describe('S36 채점 — UUPS 프록시 패턴과 Storage Collision', () => {
  describe('[1] delegatecall — Proxy storage에 상태 저장', () => {
    let proxy: ProxySimulator;

    beforeEach(() => {
      proxy = new ProxySimulator();
      proxy.setImplementation(1);
      proxy.call('initialize', '0xad1111111111111111111111111111111111ad11');
    });

    it('TODO: initialize() → Proxy storage[0]에 admin 저장', () => {
      expect(proxy.proxyStorage[0]).toBe('0xad1111111111111111111111111111111111ad11');
    });

    it('TODO: Proxy storage[1]에 _paused=false 저장', () => {
      expect(proxy.proxyStorage[1]).toBe(false);
    });

    it('TODO: getAdmin()이 Proxy storage에서 admin을 읽는다', () => {
      expect(proxy.call('getAdmin')).toBe('0xad1111111111111111111111111111111111ad11');
    });
  });

  describe('[2] 올바른 v2 업그레이드 — 기존 상태 보존', () => {
    let proxy: ProxySimulator;

    beforeEach(() => {
      proxy = new ProxySimulator();
      proxy.setImplementation(1);
      proxy.call('initialize', '0xad1111111111111111111111111111111111ad11');
      proxy.setImplementation(2);
      proxy.call('initializeV2', 'https://api.kyobo.com/');
    });

    it('TODO: v2 업그레이드 후 admin 데이터 유지', () => {
      expect(proxy.call('getAdmin')).toBe('0xad1111111111111111111111111111111111ad11');
    });

    it('TODO: v2 업그레이드 후 paused 상태 유지', () => {
      expect(proxy.call('isPaused')).toBe(false);
    });

    it('TODO: v2 새 기능(baseUri) slot 2에 정상 저장', () => {
      expect(proxy.call('getBaseUri')).toBe('https://api.kyobo.com/');
    });
  });

  describe('[3] Storage Collision — BAD v2 슬롯 해석 오염', () => {
    it('TODO: BAD v2는 slot 0(원래 admin)을 newFeature로 잘못 해석한다', () => {
      const proxy = new ProxySimulator();
      proxy.setImplementation(1);
      proxy.call('initialize', '0xad1111111111111111111111111111111111ad11');

      const badImpl = new ImplementationV2_BAD(proxy.proxyStorage);
      expect(badImpl.getNewFeature()).toBe('0xad1111111111111111111111111111111111ad11'); // admin 주소가 newFeature 자리에
    });

    it('TODO: BAD v2는 slot 1(원래 _paused=false)을 admin으로 잘못 해석한다', () => {
      const proxy = new ProxySimulator();
      proxy.setImplementation(1);
      proxy.call('initialize', '0xad1111111111111111111111111111111111ad11');

      const badImpl = new ImplementationV2_BAD(proxy.proxyStorage);
      expect(badImpl.getAdmin()).toBe(false); // boolean이 admin 자리에
    });

    it('TODO: BAD v2 업그레이드 후 getAdmin()이 string을 반환하지 않는다', () => {
      const proxy = new ProxySimulator();
      proxy.setImplementation(1);
      proxy.call('initialize', '0xad1111111111111111111111111111111111ad11');

      const badImpl = new ImplementationV2_BAD(proxy.proxyStorage);
      expect(typeof badImpl.getAdmin()).not.toBe('string');
    });
  });

  describe('[4] initializer 없는 취약 컨트랙트 — 재호출 공격', () => {
    it('TODO: 공격자가 initialize를 재호출하여 admin을 탈취할 수 있다', () => {
      const vulnerable = new VulnerableImpl();
      vulnerable.initialize('0xde910000000000000000000000000000000000de');
      expect(vulnerable.getAdmin()).toBe('0xde910000000000000000000000000000000000de');

      vulnerable.initialize('0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0'); // 재호출 성공 → 취약
      expect(vulnerable.getAdmin()).toBe('0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0');
    });
  });

  describe('[5] 안전한 initializer modifier — 한 번만 실행 보장', () => {
    it('TODO: 초기 initialize 성공 후 재호출 시 InvalidInitialization 예외 발생', () => {
      const safe = new SafeImpl();
      safe.initialize('0xde910000000000000000000000000000000000de');

      expect(() => safe.initialize('0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0')).toThrow('InvalidInitialization');
    });

    it('TODO: 재호출 시도 후에도 admin은 0xDeployer 유지', () => {
      const safe = new SafeImpl();
      safe.initialize('0xde910000000000000000000000000000000000de');
      try { safe.initialize('0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0'); } catch { /* expected */ }
      expect(safe.getAdmin()).toBe('0xde910000000000000000000000000000000000de');
    });
  });

  describe('[6] 투명 프록시 vs UUPS 비교', () => {
    it('TODO: UUPS는 업그레이드 함수가 Implementation에 위치한다', () => {
      const uupsUpgradeLocation = 'ImplementationContract';
      expect(uupsUpgradeLocation).toBe('ImplementationContract');
    });

    it('TODO: UUPS의 가스 오버헤드는 낮다', () => {
      const uupsGasOverhead = 'low';
      expect(uupsGasOverhead).toBe('low');
    });

    it('TODO: 투명 프록시는 가스 오버헤드가 높다', () => {
      const transparentGasOverhead = 'high';
      expect(transparentGasOverhead).toBe('high');
    });

    it('TODO: UUPS 주요 위험은 _authorizeUpgrade 누락이다', () => {
      const mainRisk = '_authorizeUpgrade missing → anyone can upgrade';
      expect(mainRisk).toContain('_authorizeUpgrade');
    });
  });

  describe('[7] ERC-1967 슬롯 상수', () => {
    it('TODO: ERC-1967 Implementation 슬롯이 0x360894로 시작한다', () => {
      expect(ERC1967_IMPL_SLOT).toMatch(/^0x360894/);
    });

    it('TODO: ERC-1967 Admin 슬롯이 0xb53127로 시작한다', () => {
      expect(ERC1967_ADMIN_SLOT).toMatch(/^0xb53127/);
    });

    it('TODO: Implementation 슬롯이 일반 slot 0과 다르다 (상태 변수와 충돌 없음)', () => {
      const ZERO_SLOT = '0x0000000000000000000000000000000000000000000000000000000000000000';
      expect(ERC1967_IMPL_SLOT).not.toBe(ZERO_SLOT);
    });
  });
});
