/**
 * S49 실습 — Travel Rule: 100만원 경계값 검증과 proposeTx 통합
 *
 * 강의 노트: M8_S49_travel_rule.md
 *
 * 실행 방법 (루트에서): npm run exercise:s49
 *
 * 목표:
 *   [1] checkTravelRule: 100만원 미만 → travelRuleData 없어도 통과
 *   [2] checkTravelRule: 100만원 이상 + travelRuleData 없음 → TravelRuleRequiredError
 *   [3] 경계값 케이스: 999,999 / 1,000,000 / 1,000,001
 *   [4] 필드 누락: originatorName / beneficiaryName 빈 값 → 에러
 *   [5] proposeTx 통합: 100만원 이상 TX 제안 시 Travel Rule 검증 연동
 *   [6] 특금법 §8의4 >= 연산자 확인 (초과 아닌 이상)
 */

import { randomUUID } from 'crypto';
import { ethers } from 'ethers';

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

export interface TravelRuleData {
  originatorName: string;
  originatorVasp: string;
  beneficiaryName: string;
  beneficiaryVasp: string;
  amount: bigint;
  currency: string;
}

export interface SafeTxParams {
  to: string;
  value: bigint;
  data: string;
  operation: number;
  travelRuleData?: TravelRuleData | null;
}

export type PendingTxStatus = 'PENDING_SIGNATURES' | 'READY_TO_EXECUTE' | 'EXECUTED' | 'CANCELLED';

export interface PendingTx {
  id: string;
  txHash: string;
  params: SafeTxParams;
  status: PendingTxStatus;
  requiredSignatures: number;
  collectedSignatures: [];
  proposedBy: string;
  proposedAt: Date;
}

// ─── 커스텀 에러 ──────────────────────────────────────────────────────────────

export class TravelRuleRequiredError extends Error {
  readonly amount: bigint;

  constructor(amount: bigint) {
    super(`Travel Rule required for amount: ${amount} KRW (>= 1,000,000)`);
    this.name   = 'TravelRuleRequiredError';
    this.amount = amount;
  }
}

// ─── Travel Rule 검증 유틸리티 ────────────────────────────────────────────────

/**
 * 특금법 §8의4: 100만원(1,000,000 KRW) 이상 가상자산 이전 시 Travel Rule 적용
 *
 * 100만원 이상(>=): travelRuleData 필수
 *   - originatorName: 발신인(발행 주체) 실명
 *   - beneficiaryName: 수신인(가입자) 실명
 * 100만원 미만(<): travelRuleData 불요
 */
export const TRAVEL_RULE_THRESHOLD = BigInt(1_000_000);

/**
 * TODO [1]: checkTravelRule 구현
 *
 * 요구사항:
 *   - amount >= TRAVEL_RULE_THRESHOLD(1,000,000n)이면:
 *     1. travelRuleData 없으면 TravelRuleRequiredError(amount) throw
 *     2. originatorName 빈 문자열/공백 → 에러 'Travel Rule: originatorName required'
 *     3. beneficiaryName 빈 문자열/공백 → 에러 'Travel Rule: beneficiaryName required'
 *     4. originatorVasp 빈 값 → 에러 'Travel Rule: originatorVasp required'
 *     5. beneficiaryVasp 빈 값 → 에러 'Travel Rule: beneficiaryVasp required'
 *     6. currency !== 'KRW' → 에러 `Travel Rule: currency must be KRW, got ${currency}`
 *   - 100만원 미만 → 아무 검증 없이 통과 (return 즉시)
 *
 * 힌트:
 *   - !travelRuleData.originatorName?.trim() 로 빈 값 체크
 *   - 특금법 §8의4: "이상(>=)" — "초과(>)" 아님! 경계값 주의
 */
export function checkTravelRule(amount: bigint, travelRuleData?: TravelRuleData | null): void {
  return undefined as never;
}

// ─── proposeTx 통합 시뮬레이션 ────────────────────────────────────────────────

export class SimpleProposeService {
  private readonly db = new Map<string, PendingTx>();

  async proposeTx(proposer: string, params: SafeTxParams): Promise<PendingTx> {
    // Travel Rule 검증 — 이 위치에서 차단
    checkTravelRule(params.value, params.travelRuleData);

    // 해시 계산 (시뮬레이션)
    const txHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify({ to: params.to, data: params.data, value: params.value.toString() })),
    );

    const tx: PendingTx = {
      id:                  randomUUID(),
      txHash,
      params,
      status:              'PENDING_SIGNATURES',
      requiredSignatures:  2,
      collectedSignatures: [],
      proposedBy:          proposer,
      proposedAt:          new Date(),
    };

    this.db.set(tx.id, tx);
    return tx;
  }

  get(id: string): PendingTx | undefined { return this.db.get(id); }
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

function expectNoThrow(label: string, fn: () => void): void {
  try {
    fn();
    check(label, true);
  } catch (err) {
    check(`${label} (예외 없어야 함: ${(err as Error).message})`, false);
  }
}

function expectThrows(
  label: string,
  fn: () => void,
  errorCheck?: (err: Error) => boolean,
): void {
  try {
    fn();
    check(`${label} → 에러 발생해야 함`, false);
  } catch (err) {
    if (errorCheck) {
      check(label, errorCheck(err as Error));
    } else {
      check(label, true);
    }
  }
}

async function expectAsyncThrows(
  label: string,
  fn: () => Promise<unknown>,
  errorCheck?: (err: Error) => boolean,
): Promise<void> {
  try {
    await fn();
    check(`${label} → 에러 발생해야 함`, false);
  } catch (err) {
    if (errorCheck) {
      check(label, errorCheck(err as Error));
    } else {
      check(label, true);
    }
  }
}

// 유효한 Travel Rule 데이터
export const validTravelRule: TravelRuleData = {
  originatorName: '교보생명',
  originatorVasp: 'VASP-001',
  beneficiaryName: '홍길동',
  beneficiaryVasp: 'VASP-001',
  amount: 1_000_000n,
  currency: 'KRW',
};

// ─── 실습 진입점 ──────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S49: Travel Rule — 100만원 경계값 검증과 proposeTx 통합 ===\n');

  // ── [1] 100만원 미만 → travelRuleData 없어도 통과 ────────────────────
  console.log('[검증 1] 100만원 미만 — travelRuleData 불요');

  expectNoThrow('0원 → 통과',        () => checkTravelRule(0n, null));
  expectNoThrow('500,000원 → 통과',  () => checkTravelRule(500_000n, undefined));
  expectNoThrow('999,999원 → 통과',  () => checkTravelRule(999_999n, null));
  expectNoThrow('1원 → 통과',        () => checkTravelRule(1n, null));

  // 100만원 미만이면 데이터가 있어도 없어도 통과
  expectNoThrow('500,000원 + travelRuleData 있음 → 통과 (데이터 선택적)', () =>
    checkTravelRule(500_000n, validTravelRule),
  );

  // ── [2] 100만원 이상 + travelRuleData 없음 → TravelRuleRequiredError ──
  console.log('\n[검증 2] 100만원 이상 + travelRuleData 없음 → TravelRuleRequiredError');

  expectThrows(
    '1,000,000원 + null → TravelRuleRequiredError',
    () => checkTravelRule(1_000_000n, null),
    err => err.name === 'TravelRuleRequiredError',
  );
  expectThrows(
    '1,000,001원 + undefined → TravelRuleRequiredError',
    () => checkTravelRule(1_000_001n, undefined),
    err => err.name === 'TravelRuleRequiredError',
  );
  expectThrows(
    '5,000,000원 + null → TravelRuleRequiredError',
    () => checkTravelRule(5_000_000n, null),
    err => err.name === 'TravelRuleRequiredError',
  );

  // ── [3] 경계값 케이스 — 특금법 >= 확인 ──────────────────────────────
  console.log('\n[검증 3] 경계값 정밀 테스트 — 특금법 §8의4: 이상(>=)');

  // 999,999 → 통과 (미만)
  expectNoThrow('999,999원 → 통과 (미만)', () => checkTravelRule(999_999n, null));

  // 1,000,000 → TravelRuleRequiredError (이상, 경계 포함)
  expectThrows(
    '1,000,000원 → TravelRuleRequiredError (이상 포함)',
    () => checkTravelRule(1_000_000n, null),
    err => err instanceof TravelRuleRequiredError,
  );

  // 1,000,001 → TravelRuleRequiredError (이상)
  expectThrows(
    '1,000,001원 → TravelRuleRequiredError (이상)',
    () => checkTravelRule(1_000_001n, null),
    err => err instanceof TravelRuleRequiredError,
  );

  // TravelRuleRequiredError에 amount 정보 포함
  try {
    checkTravelRule(1_500_000n, null);
  } catch (err) {
    if (err instanceof TravelRuleRequiredError) {
      check('TravelRuleRequiredError.amount = 1,500,000', err.amount === 1_500_000n);
      check('에러 메시지에 amount 포함', err.message.includes('1500000'));
    } else {
      check('TravelRuleRequiredError 타입 확인', false);
    }
  }

  // ── [4] 데이터 있으면 통과 ─────────────────────────────────────────
  console.log('\n[검증 4] 100만원 이상 + 유효한 travelRuleData → 통과');

  expectNoThrow('1,000,000원 + validTravelRule → 통과', () =>
    checkTravelRule(1_000_000n, validTravelRule),
  );
  expectNoThrow('10,000,000원 + validTravelRule → 통과', () =>
    checkTravelRule(10_000_000n, validTravelRule),
  );

  // ── [5] 필드 누락 검증 ───────────────────────────────────────────────
  console.log('\n[검증 5] 필드 누락 — originatorName / beneficiaryName 빈 값 → 에러');

  expectThrows(
    'originatorName 빈 문자열 → 에러',
    () => checkTravelRule(1_000_000n, { ...validTravelRule, originatorName: '' }),
    err => /originatorName/i.test(err.message),
  );
  expectThrows(
    'originatorName 공백만 → 에러',
    () => checkTravelRule(1_000_000n, { ...validTravelRule, originatorName: '   ' }),
    err => /originatorName/i.test(err.message),
  );
  expectThrows(
    'beneficiaryName 빈 문자열 → 에러',
    () => checkTravelRule(1_000_000n, { ...validTravelRule, beneficiaryName: '' }),
    err => /beneficiaryName/i.test(err.message),
  );
  expectThrows(
    'currency != KRW → 에러',
    () => checkTravelRule(1_000_000n, { ...validTravelRule, currency: 'USD' }),
    err => /currency/i.test(err.message),
  );

  // ── [6] proposeTx 통합 — 100만원 이상 TX 시 Travel Rule 연동 ────────
  console.log('\n[검증 6] proposeTx 통합 — 100만원 이상 TX 제안 시 검증');

  const svc = new SimpleProposeService();

  // 100만원 이상 + travelRuleData 없음 → 에러 (proposeTx에서 차단)
  await expectAsyncThrows(
    '100만원 TX + travelRuleData 없음 → TravelRuleRequiredError',
    () => svc.proposeTx('admin', { to: '0x1', value: 1_000_000n, data: '0x', operation: 0 }),
    err => err.name === 'TravelRuleRequiredError',
  );

  // 100만원 이상 + 유효한 travelRuleData → 정상 제안
  const tx = await svc.proposeTx('admin', {
    to: '0x1', value: 1_000_000n, data: '0x', operation: 0,
    travelRuleData: validTravelRule,
  });
  check('100만원 + validTravelRule → 정상 제안', tx.status === 'PENDING_SIGNATURES');
  check('params.travelRuleData 저장됨', tx.params.travelRuleData !== null);

  // 100만원 미만 → travelRuleData 없어도 정상 제안
  const txSmall = await svc.proposeTx('admin', {
    to: '0x1', value: 999_999n, data: '0x', operation: 0,
    // travelRuleData 없음
  });
  check('999,999원 TX → travelRuleData 없어도 정상 제안', txSmall.status === 'PENDING_SIGNATURES');

  // 0원 TX → travelRuleData 없어도 정상 제안 (컨트랙트 호출)
  const txZero = await svc.proposeTx('admin', {
    to: '0x1', value: 0n, data: '0x8456cb59', operation: 0,
  });
  check('0원 TX (pause 호출) → 정상 제안', txZero.status === 'PENDING_SIGNATURES');

  // ── VASP API 요청 포맷 시뮬레이션 ──────────────────────────────────
  console.log('\n[보너스] VASP API 요청 포맷 — travelRuleData 포함 시뮬레이션');

  const vaspRequest = {
    to: '0xUserWallet000000000000000000000000000000',
    tokenId: 'TOKEN-001',
    amount: 1_500_000,
    travelRuleData: {
      originatorName: validTravelRule.originatorName,
      originatorVasp: validTravelRule.originatorVasp,
      beneficiaryName: validTravelRule.beneficiaryName,
      beneficiaryVasp: validTravelRule.beneficiaryVasp,
      amount: 1_500_000,
      currency: 'KRW',
    },
  };

  check('VASP 요청 구조: travelRuleData.originatorName 포함',
    typeof vaspRequest.travelRuleData.originatorName === 'string',
  );
  check('VASP 요청 구조: travelRuleData.currency = KRW',
    vaspRequest.travelRuleData.currency === 'KRW',
  );

  // ─── 정리 ───────────────────────────────────────────────────────────────
  console.log('\n=== S49 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. 특금법 §8의4: 100만원 이상(>=) 가상자산 이전 → Travel Rule 의무');
  console.log('  2. 경계값 주의: 999,999원 → 불요 / 1,000,000원 → 필요 (>=, 이상 포함)');
  console.log('  3. travelRuleData 필수 필드: originatorName, beneficiaryName, originatorVasp, beneficiaryVasp');
  console.log('  4. Phase 1: 교보생명은 月렛원(VASP)에 travelRuleData 전달 의무 — 브로드캐스트는 월렛원');
  console.log('  5. proposeTx 내부에서 checkTravelRule 호출 → 제안 단계에서 조기 차단');
})();
