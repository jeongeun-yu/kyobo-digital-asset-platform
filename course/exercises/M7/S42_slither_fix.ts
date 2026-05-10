/**
 * S42 실습 — tx.origin 취약점과 정수 오버플로우 · HIGH 취약점 제거 원칙
 *
 * 강의 노트: M7_S42_slither_fix.md
 *
 * 실행 방법 (루트에서): npm run exercise:s42
 *
 * 목표:
 *   [1] tx.origin 취약점 탐지 + msg.sender 교체 패턴 검증
 *   [2] Integer Overflow — Solidity 0.8+ 기본 보호 vs unchecked 블록 위험성
 *   [3] ReentrancyGuard nonReentrant 뮤텍스 동작 시뮬레이션
 *   [4] CEI 패턴 + ReentrancyGuard 이중 방어 검증
 *   [5] Slither False Positive 식별 및 처리 패턴
 *
 * ────────────────────────────────────────────────────────────────────────
 * Slither 커맨드 — HIGH 취약점 제거 후 재실행:
 *
 *   # tx.origin 탐지
 *   grep -rn "tx.origin" blockchain/src/
 *
 *   # OZ 라이브러리 제외 후 HIGH만 확인
 *   slither src/rewards/KyoboNFT.sol --exclude-dependencies --detect tx-origin,reentrancy-eth
 *
 *   # 목표: HIGH 0건
 *   slither src/rewards/KyoboNFT.sol --exclude-dependencies --exclude-low
 * ────────────────────────────────────────────────────────────────────────
 */

// ────────────────────────────────────────────────────────────────────────
// 타입 정의 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

export type AccessCheckType = 'tx.origin' | 'msg.sender' | 'onlyRole';

export interface AccessPattern {
  line: number;
  code: string;
  checkType: AccessCheckType;
  isSafe: boolean;
  recommendation?: string;
}

// 코드 샘플 (수정하지 말 것)
export const VULNERABLE_CODE_LINES = [
  'require(tx.origin == owner, "Not owner");',
  'if (tx.origin != admin) revert Unauthorized();',
  'require(msg.sender == operator, "Not operator");',
];

export const FIXED_CODE_LINES = [
  'require(msg.sender == owner, "Not owner");',
  'if (msg.sender != admin) revert Unauthorized();',
  'require(msg.sender == operator, "Not operator");',
];

export const UINT8_MAX = 255n;
export const UINT8_MODULUS = 256n;

// ────────────────────────────────────────────────────────────────────────
// TODO 1: analyzeAccessPatterns 구현
//
// 코드 라인 배열을 분석하여 취약한 접근 패턴만 필터링해 반환한다.
//
// 구현 지시:
//   1. codeLines.map((code, idx) => ...) 로 각 라인을 분석한다.
//   2. code에 'tx.origin'이 포함되면:
//      → { line: idx+1, code, checkType: 'tx.origin', isSafe: false,
//          recommendation: 'tx.origin을 msg.sender로 교체하거나 onlyRole modifier로 전환' }
//   3. code에 'msg.sender ==' 또는 'msg.sender !='가 포함되면:
//      → { line, code, checkType: 'msg.sender', isSafe: true }
//   4. code에 'onlyRole(' 또는 'onlyOwner'가 포함되면:
//      → { line, code, checkType: 'onlyRole', isSafe: true }
//   5. 그 외: → { line, code, checkType: 'msg.sender', isSafe: true }
//   6. 최종적으로 checkType === 'tx.origin' || !isSafe 인 항목만 filter로 반환한다.
// ────────────────────────────────────────────────────────────────────────

export function analyzeAccessPatterns(codeLines: string[]): AccessPattern[] {
  return undefined as never;
}

// ────────────────────────────────────────────────────────────────────────
// TODO 2: checkedAdd 구현
//
// Solidity 0.8+ 기본 동작: overflow 시 revert.
//
// 구현 지시:
//   - a + b를 계산한다.
//   - 결과가 UINT8_MAX(255n)를 초과하면 { result: null, reverted: true } 반환.
//   - 그렇지 않으면 { result: a+b, reverted: false } 반환.
// ────────────────────────────────────────────────────────────────────────

export function checkedAdd(a: bigint, b: bigint): { result: bigint | null; reverted: boolean } {
  return undefined as never;
}

// ────────────────────────────────────────────────────────────────────────
// TODO 3: uncheckedAdd 구현
//
// unchecked 블록 동작: overflow 시 wrap-around (Solidity 0.8 이전 동작).
//
// 구현 지시:
//   - { result: (a + b) % UINT8_MODULUS, reverted: false } 반환.
//   - 오버플로우를 검사하지 않는다.
// ────────────────────────────────────────────────────────────────────────

export function uncheckedAdd(a: bigint, b: bigint): { result: bigint; reverted: boolean } {
  return undefined as never;
}

// ────────────────────────────────────────────────────────────────────────
// TODO 4: safeUncheckedAdd 구현
//
// unchecked 블록 사용 시 개발자가 직접 overflow를 검사하는 패턴.
//
// 구현 지시:
//   - b > UINT8_MAX - a 이면 { result: null, reverted: true } 반환.
//   - 그렇지 않으면 { result: (a + b) % UINT8_MODULUS, reverted: false } 반환.
// ────────────────────────────────────────────────────────────────────────

export function safeUncheckedAdd(
  a: bigint,
  b: bigint,
): { result: bigint | null; reverted: boolean } {
  return undefined as never;
}

// ────────────────────────────────────────────────────────────────────────
// TODO 5: ReentrancyGuardSimulator 클래스 구현
//
// OpenZeppelin ReentrancyGuard의 nonReentrant modifier 동작을 재현한다.
//
// 구현 지시:
//   private _status: NOT_ENTERED(1) 또는 ENTERED(2) 상태를 관리한다.
//
//   withNonReentrant(fn):
//     - _status === ENTERED 이면 reentrancyBlocked = true 후 throw Error
//     - 아니면 _status = ENTERED 로 설정
//     - try { fn() } finally { _status = NOT_ENTERED }
//
//   burn(balances, from, amount):
//     - withNonReentrant 내에서:
//       1. 잔액 확인 — 부족하면 throw Error
//       2. [CEI Effects] balances.set(from, current - amount)
//       3. burnCallCount++
//
//   attackWithReentrancy(balances, from):
//     - withNonReentrant 내에서:
//       1. current = balances.get(from) ?? 0
//       2. current <= 0 이면 return
//       3. try { this.burn(...) } catch { reentrancyBlocked = true }
//       4. balances.set(from, current - 1)
//       5. burnCallCount++
// ────────────────────────────────────────────────────────────────────────

const NOT_ENTERED = 1;
const ENTERED     = 2;

export class ReentrancyGuardSimulator {
  private _status = NOT_ENTERED;
  public burnCallCount = 0;
  public reentrancyBlocked = false;

  private withNonReentrant(fn: () => void): void {
    return undefined as never;
  }

  burn(balances: Map<string, number>, from: string, amount: number): void {
    return undefined as never;
  }

  attackWithReentrancy(balances: Map<string, number>, from: string): void {
    return undefined as never;
  }
}

// ────────────────────────────────────────────────────────────────────────
// False Positive 데이터 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

export type FindingVerdict = 'REAL_VULNERABILITY' | 'FALSE_POSITIVE';

export interface SlitherFindingReview {
  id: string;
  severity: string;
  title: string;
  verdict: FindingVerdict;
  reasoning: string;
  slitherDisableComment?: string;
}

export function reviewFinding(finding: SlitherFindingReview): boolean {
  return finding.verdict === 'FALSE_POSITIVE';
}

export const FINDINGS_REVIEW: SlitherFindingReview[] = [
  {
    id: 'H1',
    severity: 'HIGH',
    title: 'reentrancy-eth (burn)',
    verdict: 'REAL_VULNERABILITY',
    reasoning: 'burn()에 외부 이더 전송 없음 — 현재 KyoboNFT는 이더 전송하지 않으므로 REAL이나 미래 환불 로직 추가 시 위험. ReentrancyGuard 선제 적용.',
  },
  {
    id: 'L1',
    severity: 'LOW',
    title: 'reentrancy-no-eth (OZ 내부 이벤트)',
    verdict: 'FALSE_POSITIVE',
    reasoning: 'OZ ERC1155의 _balances 업데이트 후 TransferSingle 이벤트 발생 패턴. 외부 호출 없음 — OZ 내부 구현 패턴이므로 실제 취약점 아님.',
    slitherDisableComment: '// slither-disable-next-line reentrancy-no-eth',
  },
  {
    id: 'L2',
    severity: 'LOW',
    title: 'pragma-floating',
    verdict: 'FALSE_POSITIVE',
    reasoning: '실제 파일에 pragma solidity 0.8.20 (캐럿 없음) 으로 특정 버전 고정됨. Slither 오탐.',
    slitherDisableComment: '// slither-disable-next-line solc-version',
  },
];

// ────────────────────────────────────────────────────────────────────────
// 헬퍼 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점 (수정하지 말 것)
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S42: tx.origin 제거 + ReentrancyGuard 적용 + HIGH 0건 달성 ===\n');

  // ── [1] tx.origin 탐지 ──────────────────────────────────────────────
  console.log('[검증 1] tx.origin 취약 패턴 탐지');

  const vulnerablePatterns = analyzeAccessPatterns(VULNERABLE_CODE_LINES);
  const fixedPatterns      = analyzeAccessPatterns(FIXED_CODE_LINES);

  check('취약 코드: tx.origin 패턴 2건 탐지',         vulnerablePatterns.length === 2);
  check('취약 코드: 모두 isSafe=false',                vulnerablePatterns.every(p => !p.isSafe));
  check('수정 코드: tx.origin 패턴 0건',               fixedPatterns.length === 0);
  check('취약 항목에 recommendation 포함',
    vulnerablePatterns.every(p => p.recommendation !== undefined),
  );

  // ── [2] Integer Overflow 보호 ─────────────────────────────────────────
  console.log('\n[검증 2] Integer Overflow — 0.8+ 기본 보호 vs unchecked');

  const overflowCase = checkedAdd(255n, 1n);
  const normalCase   = checkedAdd(100n, 50n);

  check('0.8+ 기본: 255 + 1 → revert (overflow 차단)', overflowCase.reverted === true);
  check('0.8+ 기본: 100 + 50 = 150 → 정상',            normalCase.result === 150n);

  const uncheckedOverflow = uncheckedAdd(255n, 1n);
  check('unchecked: 255 + 1 → 0 (wrap-around, 위험)',  uncheckedOverflow.result === 0n);

  const safeUncheckedOverflow = safeUncheckedAdd(255n, 1n);
  const safeUncheckedNormal   = safeUncheckedAdd(100n, 50n);
  check('unchecked 직접 검증: 255 + 1 → revert',       safeUncheckedOverflow.reverted === true);
  check('unchecked 직접 검증: 100 + 50 = 150 → 정상',  safeUncheckedNormal.result === 150n);

  // ── [3] ReentrancyGuard 뮤텍스 ──────────────────────────────────────
  console.log('\n[검증 3] ReentrancyGuard nonReentrant — 재진입 차단');

  const guard1 = new ReentrancyGuardSimulator();
  const balances1 = new Map([['user', 5]]);
  guard1.burn(balances1, 'user', 1);

  check('정상 burn: 소각 1회 성공',            guard1.burnCallCount === 1);
  check('정상 burn: 잔액 5 → 4',              balances1.get('user') === 4);
  check('정상 burn: 재진입 차단 없음',          guard1.reentrancyBlocked === false);

  const guard2 = new ReentrancyGuardSimulator();
  const balances2 = new Map([['attacker', 5]]);

  try {
    guard2.attackWithReentrancy(balances2, 'attacker');
  } catch (_e) {
    // expected
  }

  check('재진입 공격: ReentrancyGuard가 차단 (blocked=true)', guard2.reentrancyBlocked === true);
  check('재진입 공격: 정상 burn은 1회만 실행',                 guard2.burnCallCount === 1);

  // ── [4] CEI + ReentrancyGuard 이중 방어 ─────────────────────────────
  console.log('\n[검증 4] CEI 패턴 + ReentrancyGuard 이중 방어');

  const guard3 = new ReentrancyGuardSimulator();
  const balances3 = new Map([['attacker', 5]]);

  guard3.burn(balances3, 'attacker', 1);
  check('이중 방어: 소각 후 잔액 정확히 4',    balances3.get('attacker') === 4);
  check('이중 방어: burnCallCount = 1',         guard3.burnCallCount === 1);
  check('이중 방어: 재진입 없음',               guard3.reentrancyBlocked === false);

  // ── [5] False Positive 판별 ───────────────────────────────────────────
  console.log('\n[검증 5] Slither False Positive 식별');

  const realVulnerabilities = FINDINGS_REVIEW.filter(f => !reviewFinding(f));
  const falsePositives      = FINDINGS_REVIEW.filter(f => reviewFinding(f));

  check('실제 취약점 1건 (H1: reentrancy)',     realVulnerabilities.length === 1);
  check('False Positive 2건 (L1, L2)',          falsePositives.length === 2);
  check('False Positive에 slither-disable 주석 포함',
    falsePositives.every(f => f.slitherDisableComment !== undefined),
  );
  check('H1은 REAL_VULNERABILITY — 선제 조치 필요',
    realVulnerabilities[0]?.verdict === 'REAL_VULNERABILITY',
  );

  // ── 정리 ────────────────────────────────────────────────────────────
  console.log('\n=== S42 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. tx.origin: KyoboNFT.sol에서 grep으로 전량 탐지 → 전부 msg.sender로 교체');
  console.log('  2. Solidity 0.8+: overflow 기본 차단. unchecked 블록 사용 시 직접 검증 필수');
  console.log('  3. ReentrancyGuard: _status 뮤텍스로 재진입 시 revert — nonReentrant modifier');
  console.log('  4. CEI(논리 방어) + ReentrancyGuard(기술 방어) 둘 다 적용이 최선');
  console.log('  5. False Positive: OZ 내부 패턴, pragma 고정 등 — 코드 흐름 직접 추적 후 판단');
  console.log('  6. Slither 목표: HIGH 0건 달성 → S43에서 MEDIUM 0건까지');
})();
