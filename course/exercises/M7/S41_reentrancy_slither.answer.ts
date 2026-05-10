/**
 * S41 실습 — 스마트컨트랙트 주요 공격 벡터와 정적 분석 방법론
 *
 * 강의 노트: M7_S41_reentrancy_slither.md
 *
 * 실행 방법 (루트에서): npm run exercise:s41
 *
 * 목표:
 *   [1] Reentrancy 공격 취약 패턴 — 잘못된 실행 순서 시뮬레이션
 *   [2] CEI(Check-Effects-Interactions) 패턴 적용 — 상태 먼저, 외부 호출 나중에
 *   [3] tx.origin vs msg.sender 피싱 공격 취약점 비교
 *   [4] Slither 심각도별 분류 기준 이해 (HIGH / MEDIUM / LOW / INFO)
 *   [5] Slither 실행 커맨드 목록 확인
 *
 * ────────────────────────────────────────────────────────────────────────
 * Slither 실행 커맨드 (blockchain 디렉토리에서 실행):
 *
 *   # 설치
 *   pip install slither-analyzer
 *
 *   # 전체 분석
 *   slither src/rewards/KyoboNFT.sol --config-file slither.config.json
 *
 *   # HIGH/MEDIUM만 확인
 *   slither src/rewards/KyoboNFT.sol --exclude-dependencies --exclude-low
 *
 *   # 재진입 + tx.origin 항목만 확인
 *   slither src/rewards/KyoboNFT.sol --detect reentrancy-eth,tx-origin
 *
 *   # JSON 리포트 저장
 *   slither src/rewards/KyoboNFT.sol --json slither-report.json
 * ────────────────────────────────────────────────────────────────────────
 */

// ────────────────────────────────────────────────────────────────────────
// Slither 심각도 분류 정의
// ────────────────────────────────────────────────────────────────────────

export type SlitherSeverity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';

export interface SlitherFinding {
  id: string;
  severity: SlitherSeverity;
  title: string;
  description: string;
  mustFix: boolean;
}

export const SEVERITY_POLICY: Record<SlitherSeverity, { action: string; mustFix: boolean }> = {
  HIGH:          { action: '반드시 수정 — 자산 손실 가능',           mustFix: true  },
  MEDIUM:        { action: '수정 권장 — 비정상 동작 가능',           mustFix: false },
  LOW:           { action: '검토 후 결정 — 모범 사례 위반',          mustFix: false },
  INFORMATIONAL: { action: '선택적 — 스타일·최적화 제안',            mustFix: false },
};

// ────────────────────────────────────────────────────────────────────────
// 실습 1: Reentrancy 취약 패턴 시뮬레이션
// ────────────────────────────────────────────────────────────────────────

/**
 * KyoboNFT.burn() 의 취약한 실행 순서를 TypeScript로 모델링.
 * 실제 Solidity 컨트랙트가 아니라 공격 흐름을 이해하기 위한 시뮬레이션.
 *
 * 취약한 순서 (Interactions → Effects):
 *   1. 잔액 확인 (Check)
 *   2. 외부에 이더 전송 (Interactions) ← 공격자가 재진입하는 지점
 *   3. 상태 차감 (Effects)               ← 너무 늦음
 */

export type BurnResult = 'success' | 'reentrancy_exploited';

export function simulateVulnerableBurn(
  balances: Map<string, number>,
  attacker: string,
  callCount: { value: number },
  maxReentrancy: number,
): BurnResult {
  const amount = balances.get(attacker) ?? 0;
  if (amount <= 0) return 'success';

  // ❌ Interactions 먼저 — 외부 호출 (이더 전송 시뮬레이션)
  // 이 시점에서 공격자 컨트랙트의 receive()가 실행되어 재진입
  if (callCount.value < maxReentrancy) {
    callCount.value++;
    // 재진입: 잔액이 아직 차감되지 않았으므로 또 인출 가능
    simulateVulnerableBurn(balances, attacker, callCount, maxReentrancy);
  }

  // ❌ Effects 나중에 — 이미 재진입이 발생한 후 차감
  balances.set(attacker, (balances.get(attacker) ?? 0) - 1);

  return callCount.value >= maxReentrancy ? 'reentrancy_exploited' : 'success';
}

/**
 * CEI 패턴 적용 — 안전한 실행 순서 (Effects → Interactions)
 *
 *   1. Check:        잔액 확인
 *   2. Effects:      상태 차감 먼저 (재진입 시 잔액이 0)
 *   3. Interactions: 외부 호출 나중에
 */
export function simulateSafeBurn(
  balances: Map<string, number>,
  attacker: string,
  callCount: { value: number },
  maxReentrancy: number,
): { success: boolean; burnedCount: number } {
  const amount = balances.get(attacker) ?? 0;

  // 1. Check
  if (amount <= 0) return { success: false, burnedCount: 0 };

  // 2. Effects — 상태 먼저 변경
  balances.set(attacker, amount - 1);

  // 3. Interactions — 외부 호출 (재진입 시도)
  if (callCount.value < maxReentrancy) {
    callCount.value++;
    // 재진입: 잔액이 이미 차감됐으므로 추가 인출 불가
    simulateSafeBurn(balances, attacker, callCount, maxReentrancy);
  }

  return { success: true, burnedCount: 1 };
}

// ────────────────────────────────────────────────────────────────────────
// 실습 2: tx.origin vs msg.sender 피싱 공격 시뮬레이션
// ────────────────────────────────────────────────────────────────────────

/**
 * tx.origin 기반 권한 체크: 중간 컨트랙트를 통해 우회 가능
 *
 * 공격 흐름:
 *   피해자(EOA) → 공격자 컨트랙트.무관한함수() → KyoboNFT.sensitiveOp()
 *   tx.origin = 피해자 (admin) → 권한 통과
 *   msg.sender = 공격자 컨트랙트 → 실제 호출 주체
 */
export function checkWithTxOrigin(
  txOrigin: string,   // 트랜잭션 최초 발신자 (항상 EOA)
  _msgSender: string, // 현재 함수를 직접 호출한 주소 (컨트랙트일 수 있음)
  owner: string,
): boolean {
  // ❌ 취약한 패턴: tx.origin 사용
  return txOrigin === owner;
}

export function checkWithMsgSender(
  _txOrigin: string,
  msgSender: string,  // 직접 호출한 주소 — 컨트랙트이면 권한 없음
  owner: string,
): boolean {
  // ✅ 안전한 패턴: msg.sender 사용
  return msgSender === owner;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 3: Slither 분석 결과 분류 시뮬레이션
// ────────────────────────────────────────────────────────────────────────

export const MOCK_SLITHER_FINDINGS: SlitherFinding[] = [
  {
    id: 'H1',
    severity: 'HIGH',
    title: 'reentrancy-eth',
    description: 'burn() — 외부 호출 전에 상태 변경 없음. 재진입 공격 가능.',
    mustFix: true,
  },
  {
    id: 'H2',
    severity: 'HIGH',
    title: 'tx-origin',
    description: 'tx.origin == owner 패턴 감지. msg.sender로 교체 필요.',
    mustFix: true,
  },
  {
    id: 'M1',
    severity: 'MEDIUM',
    title: 'events-access',
    description: 'updateMaxSupply() — 접근 제어는 있으나 이벤트 누락.',
    mustFix: false,
  },
  {
    id: 'M2',
    severity: 'MEDIUM',
    title: 'access-control',
    description: 'updateTokenURI() — onlyRole modifier 없음. 누구나 호출 가능.',
    mustFix: false,
  },
  {
    id: 'L1',
    severity: 'LOW',
    title: 'pragma-floating',
    description: 'pragma solidity ^0.8.20 — 특정 버전으로 고정 권장.',
    mustFix: false,
  },
  {
    id: 'I1',
    severity: 'INFORMATIONAL',
    title: 'naming-convention',
    description: '상수명 PRODUCT_CODE_SHIFT를 PRODUCT_CODE_BIT_SHIFT로 변경 권장.',
    mustFix: false,
  },
];

export function classifyFindings(findings: SlitherFinding[]): Record<SlitherSeverity, SlitherFinding[]> {
  const result: Record<SlitherSeverity, SlitherFinding[]> = {
    HIGH: [], MEDIUM: [], LOW: [], INFORMATIONAL: [],
  };
  for (const f of findings) {
    result[f.severity].push(f);
  }
  return result;
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
  console.log('=== S41: 스마트컨트랙트 공격 벡터 + Slither 정적 분석 ===\n');

  // ── [1] Reentrancy 취약 패턴 시뮬레이션 ─────────────────────────────
  console.log('[검증 1] Reentrancy 취약 패턴 — 상태 차감 전에 재진입 허용');

  const vulnBalances = new Map<string, number>([['attacker', 5]]);
  const callCount1 = { value: 0 };
  const vulnResult = simulateVulnerableBurn(vulnBalances, 'attacker', callCount1, 3);

  // 재진입이 발생했고 잔액이 1개 초과 차감됨 (취약)
  const vulnBalance = vulnBalances.get('attacker') ?? 0;
  check('취약 패턴: 재진입 발생 (callCount > 1)',   callCount1.value > 1);
  check('취약 패턴: 잔액이 정상(4)보다 더 차감됨', vulnBalance < 4);
  check('취약 패턴 결과: reentrancy_exploited',      vulnResult === 'reentrancy_exploited');

  // ── [2] CEI 패턴 — 안전한 burn ───────────────────────────────────────
  console.log('\n[검증 2] CEI 패턴 — 상태 먼저 차감 후 외부 호출');

  const safeBalances = new Map<string, number>([['attacker', 5]]);
  const callCount2 = { value: 0 };
  const safeResult = simulateSafeBurn(safeBalances, 'attacker', callCount2, 3);

  const safeBalance = safeBalances.get('attacker') ?? 0;
  check('CEI 패턴: 최초 1번만 소각 성공',          safeResult.success === true);
  check('CEI 패턴: 재진입 시도 발생함',              callCount2.value > 0);
  check('CEI 패턴: 실제 소각은 1개만 (잔액 = 4)',    safeBalance === 4);
  check('CEI 패턴: 재진입이 추가 소각을 유발하지 않음', safeResult.burnedCount === 1);

  // ── [3] tx.origin vs msg.sender ─────────────────────────────────────
  console.log('\n[검증 3] tx.origin vs msg.sender — 피싱 공격 취약점');

  const owner            = '0xOWNER';
  const victimEOA        = '0xOWNER';    // owner이기도 한 피해자
  const attackerContract = '0xATTACKER'; // 중간 컨트랙트

  // 피해자가 공격자 컨트랙트를 통해 간접 호출:
  //   tx.origin = victimEOA (= owner), msg.sender = attackerContract
  const txOriginResult  = checkWithTxOrigin(victimEOA, attackerContract, owner);
  const msgSenderResult = checkWithMsgSender(victimEOA, attackerContract, owner);

  check('tx.origin 체크: 공격자 컨트랙트가 owner 권한으로 통과 (취약)',  txOriginResult  === true);
  check('msg.sender 체크: 공격자 컨트랙트는 권한 없음으로 차단 (안전)',  msgSenderResult === false);
  check('직접 호출(EOA)은 둘 다 통과',
    checkWithTxOrigin(owner, owner, owner) === true &&
    checkWithMsgSender(owner, owner, owner) === true,
  );

  // ── [4] Slither 심각도 정책 ─────────────────────────────────────────
  console.log('\n[검증 4] Slither 심각도별 분류 정책');

  for (const [severity, policy] of Object.entries(SEVERITY_POLICY)) {
    const s = severity as SlitherSeverity;
    check(`${s}: mustFix=${policy.mustFix} — ${policy.action}`,
      SEVERITY_POLICY[s] !== undefined,
    );
  }
  check('HIGH는 반드시 수정',          SEVERITY_POLICY['HIGH'].mustFix === true);
  check('INFORMATIONAL은 선택적',      SEVERITY_POLICY['INFORMATIONAL'].mustFix === false);

  // ── [5] Slither 분석 결과 분류 ───────────────────────────────────────
  console.log('\n[검증 5] Slither 분석 결과 — 심각도별 분류');

  const classified = classifyFindings(MOCK_SLITHER_FINDINGS);

  check('HIGH 항목 2건 (reentrancy + tx.origin)',   classified.HIGH.length === 2);
  check('MEDIUM 항목 2건 (이벤트누락 + 접근제어)',   classified.MEDIUM.length === 2);
  check('LOW 항목 1건 (pragma floating)',            classified.LOW.length === 1);
  check('INFORMATIONAL 항목 1건',                    classified.INFORMATIONAL.length === 1);

  // HIGH 항목 중 mustFix 여부 확인
  const highMustFix = classified.HIGH.every(f => f.mustFix);
  check('HIGH 항목 전부 mustFix=true',               highMustFix);

  // 필드 구조 확인
  const h1 = classified.HIGH.find(f => f.id === 'H1');
  check('H1: reentrancy-eth 항목 포함',              h1?.title === 'reentrancy-eth');
  check('H2: tx-origin 항목 포함',                   classified.HIGH.some(f => f.title === 'tx-origin'));

  // ── 정리 ────────────────────────────────────────────────────────────
  console.log('\n=== S41 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. Reentrancy: 외부 호출 전에 상태 변경 없으면 재진입 공격으로 자산 탈취 가능');
  console.log('  2. CEI 패턴: Check → Effects(상태변경) → Interactions(외부호출) 순서 엄수');
  console.log('  3. tx.origin: 중간 컨트랙트를 통한 피싱 공격에 취약 — msg.sender로 교체');
  console.log('  4. Slither HIGH: 반드시 수정, MEDIUM: 수정 권장, LOW/INFO: 검토 후 결정');
  console.log('  5. 스마트컨트랙트는 배포 후 수정 불가 — 감사는 배포 전 필수');
})();
