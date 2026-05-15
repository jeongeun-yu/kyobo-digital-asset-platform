/**
 * S09 실습 — At-least-once + 멱등성
 *
 * 실행 방법: npm run exercise:s09
 *
 * 아래 실험 변수를 바꾸고 실행하면서 출력이 어떻게 달라지는지 확인하세요.
 * 각 실험의 의미는 실습 가이드(M2_S9_atleastonce_design.md)를 참고하세요.
 */

// ══════════════════════════════════════════════════════════════════
//  실험 변수 — 여기 값을 바꿔가며 실행해보세요
// ══════════════════════════════════════════════════════════════════

/** 실험 1: 같은 메시지를 몇 번 보낼까요? (1, 2, 3 으로 바꿔보세요) */
const DUPLICATE_COUNT = 2;

/** 실험 2: 멱등성을 켤까요? (false → true 로 바꿔보세요) */
const USE_IDEMPOTENCY = false;

/** 실험 3: XACK를 처리 전에 할까요? (false → true 로 바꿔보세요) */
const ACK_BEFORE_PROCESS = false;

/** 실험 4: 처리 도중 크래시를 낼까요? (false → true 로 바꿔보세요) */
const SIMULATE_CRASH = false;

// ══════════════════════════════════════════════════════════════════
//  아래는 수정하지 않아도 됩니다
// ══════════════════════════════════════════════════════════════════

const ledger      = new Map<string, number>();
const processedIds = new Set<string>();

async function processMessage(requestId: string, tokenId: string): Promise<string> {
  if (ACK_BEFORE_PROCESS) {
    // XACK 선행 — 이후 크래시 시 메시지 유실
  }

  if (USE_IDEMPOTENCY && processedIds.has(requestId)) {
    return '스킵 (멱등성)';
  }

  if (SIMULATE_CRASH) {
    throw new Error('SIMULATED_CRASH');
  }

  const prev = ledger.get(tokenId) ?? 0;
  ledger.set(tokenId, prev + 1);

  if (USE_IDEMPOTENCY) processedIds.add(requestId);

  return `처리됨 (누적: ${prev + 1}회)`;
}

(async () => {
  const LINE = '─'.repeat(52);
  const TOKEN_ID   = 'T-001';
  const REQUEST_ID = 'req-001';

  console.log('\n' + LINE);
  console.log('  S09 실습 — At-least-once + 멱등성');
  console.log(LINE);
  console.log(`  DUPLICATE_COUNT    = ${DUPLICATE_COUNT}`);
  console.log(`  USE_IDEMPOTENCY    = ${USE_IDEMPOTENCY}`);
  console.log(`  ACK_BEFORE_PROCESS = ${ACK_BEFORE_PROCESS}`);
  console.log(`  SIMULATE_CRASH     = ${SIMULATE_CRASH}`);
  console.log(LINE + '\n');

  for (let i = 1; i <= DUPLICATE_COUNT; i++) {
    try {
      const outcome = await processMessage(REQUEST_ID, TOKEN_ID);
      console.log(`  메시지 ${i}/${DUPLICATE_COUNT}: ${outcome}`);
    } catch {
      console.log(`  메시지 ${i}/${DUPLICATE_COUNT}: 크래시 — XACK 없음`);
    }
  }

  const finalCount = ledger.get(TOKEN_ID) ?? 0;
  console.log('\n' + LINE);
  console.log(`  최종 원장 적립 횟수: ${finalCount}회`);
  if (SIMULATE_CRASH && finalCount === 0) {
    console.log('  ⚠️  크래시 — 처리 미완료');
  } else if (finalCount === 1) {
    console.log('  ✅ 정상 — 1회 처리');
  } else {
    console.log(`  ❌ 중복 발행 — ${finalCount}회 적립`);
  }
  console.log(LINE + '\n');
})();
