/**
 * S41 채점 — 스마트컨트랙트 주요 공격 벡터와 정적 분석 방법론
 *
 * 검증 항목:
 *   [1] 재진입 공격 성공(취약 패턴) vs 실패(CEI 패턴) 비교
 *   [2] CEI 패턴 — 상태 먼저 차감 후 외부 호출
 *   [3] tx.origin vs msg.sender 피싱 공격 취약점
 *   [4] Slither finding 심각도 분류 (HIGH / MEDIUM / LOW / INFO)
 *   [5] Slither 분석 결과 — 심각도별 분류
 */

import {
  SlitherSeverity,
  SlitherFinding,
  SEVERITY_POLICY,
  MOCK_SLITHER_FINDINGS,
  BurnResult,
  simulateVulnerableBurn,
  simulateSafeBurn,
  checkWithTxOrigin,
  checkWithMsgSender,
  classifyFindings,
} from '../M7/S41_reentrancy_slither';

// ── 테스트 ───────────────────────────────────────────────────────────────────

describe('S41 채점 — 스마트컨트랙트 공격 벡터 + Slither 정적 분석', () => {
  describe('[1] Reentrancy 취약 패턴 — 상태 차감 전에 재진입 허용', () => {
    it('TODO: 취약 패턴은 재진입이 1회 이상 발생한다 (callCount > 1)', () => {
      const vulnBalances = new Map<string, number>([['attacker', 5]]);
      const callCount = { value: 0 };
      simulateVulnerableBurn(vulnBalances, 'attacker', callCount, 3);
      expect(callCount.value).toBeGreaterThan(1);
    });

    it('TODO: 취약 패턴은 잔액이 정상(4)보다 더 차감된다', () => {
      const vulnBalances = new Map<string, number>([['attacker', 5]]);
      const callCount = { value: 0 };
      simulateVulnerableBurn(vulnBalances, 'attacker', callCount, 3);
      expect(vulnBalances.get('attacker')!).toBeLessThan(4);
    });

    it('TODO: 취약 패턴 결과가 reentrancy_exploited이다', () => {
      const vulnBalances = new Map<string, number>([['attacker', 5]]);
      const callCount = { value: 0 };
      const result = simulateVulnerableBurn(vulnBalances, 'attacker', callCount, 3);
      expect(result).toBe('reentrancy_exploited');
    });
  });

  describe('[2] CEI 패턴 — 상태 먼저 차감 후 외부 호출', () => {
    it('TODO: CEI 패턴은 최초 1번 소각만 성공한다', () => {
      const safeBalances = new Map<string, number>([['attacker', 5]]);
      const callCount = { value: 0 };
      const result = simulateSafeBurn(safeBalances, 'attacker', callCount, 3);
      expect(result.success).toBe(true);
    });

    it('TODO: CEI 패턴에서 재진입 시도가 발생한다', () => {
      const safeBalances = new Map<string, number>([['attacker', 5]]);
      const callCount = { value: 0 };
      simulateSafeBurn(safeBalances, 'attacker', callCount, 3);
      expect(callCount.value).toBeGreaterThan(0);
    });

    it('TODO: CEI 패턴에서 재진입 시도마다 잔액이 차감되지만 각 호출은 정상 소각 로직을 따른다', () => {
      // CEI 핵심: 재진입 시점에 잔액이 이미 차감되어 있어 음수로 내려가지 않는다
      const safeBalances = new Map<string, number>([['attacker', 5]]);
      const callCount = { value: 0 };
      simulateSafeBurn(safeBalances, 'attacker', callCount, 3);
      // 잔액이 0 이상 유지됨 (overflow 없음)
      expect(safeBalances.get('attacker')!).toBeGreaterThanOrEqual(0);
    });

    it('TODO: CEI 패턴은 재진입이 추가 소각을 유발하지 않는다 (burnedCount = 1)', () => {
      const safeBalances = new Map<string, number>([['attacker', 5]]);
      const callCount = { value: 0 };
      const result = simulateSafeBurn(safeBalances, 'attacker', callCount, 3);
      expect(result.burnedCount).toBe(1);
    });
  });

  describe('[3] tx.origin vs msg.sender — 피싱 공격 취약점', () => {
    const owner            = '0x0000000000000000000000000000000000000001';
    const victimEOA        = '0x0000000000000000000000000000000000000001';
    const attackerContract = '0xbad0bad0bad0bad0bad0bad0bad0bad0bad0bad0';

    it('TODO: tx.origin 체크: 공격자 컨트랙트가 owner 권한으로 통과한다 (취약)', () => {
      const result = checkWithTxOrigin(victimEOA, attackerContract, owner);
      expect(result).toBe(true);
    });

    it('TODO: msg.sender 체크: 공격자 컨트랙트는 권한 없음으로 차단된다 (안전)', () => {
      const result = checkWithMsgSender(victimEOA, attackerContract, owner);
      expect(result).toBe(false);
    });

    it('TODO: EOA 직접 호출 시 tx.origin 체크도 통과한다', () => {
      expect(checkWithTxOrigin(owner, owner, owner)).toBe(true);
    });

    it('TODO: EOA 직접 호출 시 msg.sender 체크도 통과한다', () => {
      expect(checkWithMsgSender(owner, owner, owner)).toBe(true);
    });
  });

  describe('[4] Slither 심각도 정책', () => {
    it('TODO: HIGH는 mustFix=true이다', () => {
      expect(SEVERITY_POLICY['HIGH'].mustFix).toBe(true);
    });

    it('TODO: MEDIUM은 mustFix=false이다', () => {
      expect(SEVERITY_POLICY['MEDIUM'].mustFix).toBe(false);
    });

    it('TODO: LOW는 mustFix=false이다', () => {
      expect(SEVERITY_POLICY['LOW'].mustFix).toBe(false);
    });

    it('TODO: INFORMATIONAL은 mustFix=false이다', () => {
      expect(SEVERITY_POLICY['INFORMATIONAL'].mustFix).toBe(false);
    });

    it('TODO: SEVERITY_POLICY에 4가지 심각도가 모두 정의된다', () => {
      expect(Object.keys(SEVERITY_POLICY)).toHaveLength(4);
    });
  });

  describe('[5] Slither 분석 결과 — 심각도별 분류', () => {
    it('TODO: HIGH 항목이 2건이다 (reentrancy + tx.origin)', () => {
      const classified = classifyFindings(MOCK_SLITHER_FINDINGS);
      expect(classified.HIGH).toHaveLength(2);
    });

    it('TODO: MEDIUM 항목이 2건이다 (이벤트누락 + 접근제어)', () => {
      const classified = classifyFindings(MOCK_SLITHER_FINDINGS);
      expect(classified.MEDIUM).toHaveLength(2);
    });

    it('TODO: LOW 항목이 1건이다 (pragma floating)', () => {
      const classified = classifyFindings(MOCK_SLITHER_FINDINGS);
      expect(classified.LOW).toHaveLength(1);
    });

    it('TODO: INFORMATIONAL 항목이 1건이다', () => {
      const classified = classifyFindings(MOCK_SLITHER_FINDINGS);
      expect(classified.INFORMATIONAL).toHaveLength(1);
    });

    it('TODO: HIGH 항목 전부 mustFix=true이다', () => {
      const classified = classifyFindings(MOCK_SLITHER_FINDINGS);
      expect(classified.HIGH.every(f => f.mustFix)).toBe(true);
    });

    it('TODO: H1 항목의 title이 reentrancy-eth이다', () => {
      const classified = classifyFindings(MOCK_SLITHER_FINDINGS);
      const h1 = classified.HIGH.find(f => f.id === 'H1');
      expect(h1?.title).toBe('reentrancy-eth');
    });

    it('TODO: H2 항목의 title이 tx-origin이다', () => {
      const classified = classifyFindings(MOCK_SLITHER_FINDINGS);
      expect(classified.HIGH.some(f => f.title === 'tx-origin')).toBe(true);
    });
  });
});
