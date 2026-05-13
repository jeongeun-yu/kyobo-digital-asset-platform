/**
 * S09 실습 — At-least-once + 멱등성
 *
 * 실행 방법: npm run exercise:s09
 *
 * 아래 실험 변수를 바꾸고 실행하면서 출력이 어떻게 달라지는지 확인하세요.
 * 각 실험마다 무슨 일이 일어나는지 강의 노트와 함께 읽어보세요.
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

// ── 인메모리 원장 ───────────────────────────────────────────────
const ledger = new Map<string, number>();

function creditNFT(tokenId: string, owner: string): void {
  const prev = ledger.get(tokenId) ?? 0;
  ledger.set(tokenId, prev + 1);
  console.log(`  [원장] ${tokenId} → ${owner} 적립 | 누적: ${prev + 1}회`);
}

// ── 멱등성 저장소 ───────────────────────────────────────────────
const processedIds = new Set<string>();

// ── 단일 메시지 처리 ────────────────────────────────────────────
async function processMessage(
  requestId: string,
  tokenId:   string,
  owner:     string,
): Promise<void> {

  // ── XACK 먼저? (실험 3: ACK_BEFORE_PROCESS = true 일 때) ──────
  if (ACK_BEFORE_PROCESS) {
    console.log(`  [XACK] 처리 전에 ACK 전송 — 위험!`);
    // 이 시점에서 크래시 나면 DB 처리 없이 메시지가 사라짐
  }

  // ── 멱등성 확인 (실험 2: USE_IDEMPOTENCY = true 일 때) ─────────
  if (USE_IDEMPOTENCY && processedIds.has(requestId)) {
    console.log(`  [멱등성] 이미 처리된 요청 — 스킵: ${requestId}`);
    if (!ACK_BEFORE_PROCESS) {
      console.log(`  [XACK] 스킵 후 ACK 전송`);
    }
    return;
  }

  // ── 크래시 시뮬레이션 (실험 4: SIMULATE_CRASH = true 일 때) ───
  if (SIMULATE_CRASH) {
    console.log(`  [크래시] DB 처리 전 프로세스 종료 시뮬레이션`);
    throw new Error('SIMULATED_CRASH');
  }

  // ── DB 처리 (원장 업데이트) ─────────────────────────────────────
  creditNFT(tokenId, owner);

  // ── 처리 완료 기록 ──────────────────────────────────────────────
  if (USE_IDEMPOTENCY) {
    processedIds.add(requestId);
  }

  // ── XACK 마지막 (정상 순서) ─────────────────────────────────────
  if (!ACK_BEFORE_PROCESS) {
    console.log(`  [XACK] 처리 완료 후 ACK 전송 ✅`);
  }
}

// ── 실험 실행 ────────────────────────────────────────────────────
(async () => {
  const LINE = '─'.repeat(52);

  console.log('\n' + LINE);
  console.log('  S09 실습 — At-least-once + 멱등성');
  console.log(LINE);
  console.log(`  DUPLICATE_COUNT    = ${DUPLICATE_COUNT}`);
  console.log(`  USE_IDEMPOTENCY    = ${USE_IDEMPOTENCY}`);
  console.log(`  ACK_BEFORE_PROCESS = ${ACK_BEFORE_PROCESS}`);
  console.log(`  SIMULATE_CRASH     = ${SIMULATE_CRASH}`);
  console.log(LINE + '\n');

  ledger.clear();
  processedIds.clear();

  const REQUEST_ID = 'req-001';
  const TOKEN_ID   = 'T-001';
  const OWNER      = '0xKYOBO';

  for (let i = 1; i <= DUPLICATE_COUNT; i++) {
    console.log(`[메시지 ${i}/${DUPLICATE_COUNT}] requestId=${REQUEST_ID} 수신`);
    try {
      await processMessage(REQUEST_ID, TOKEN_ID, OWNER);
    } catch (e: any) {
      console.log(`  [오류] ${e.message}`);
      console.log(`  → 크래시 발생: XACK 안 됨, PEL에 메시지 잔류`);
      console.log(`  → 재시작 후 이 메시지를 다시 수신하게 됩니다`);
    }
    console.log();
  }

  // ── 최종 결과 ────────────────────────────────────────────────
  const finalCount = ledger.get(TOKEN_ID) ?? 0;
  const isCorrect  = finalCount === 1;

  console.log(LINE);
  console.log(`  최종 원장 적립 횟수: ${finalCount}회`);

  if (SIMULATE_CRASH) {
    console.log(`  → 크래시로 인해 처리 미완료 상태`);
    console.log(`  → 재시작 시 멱등성이 있으면 안전하게 재처리됩니다`);
  } else if (isCorrect) {
    console.log(`  ✅ 정상 — 중복 없이 정확히 1회 처리`);
  } else {
    console.log(`  ❌ 중복 발행! — NFT가 ${finalCount}회 적립됨`);
    if (!USE_IDEMPOTENCY) {
      console.log(`  → USE_IDEMPOTENCY = true 로 바꿔보세요`);
    }
  }

  if (ACK_BEFORE_PROCESS && SIMULATE_CRASH) {
    console.log(`  ⚠️  ACK 먼저 + 크래시: 메시지 유실 (재수신 불가)`);
  }

  console.log(LINE + '\n');

  // ── 관찰 가이드 ──────────────────────────────────────────────
  console.log('[ 다음 실험을 해보세요 ]');
  console.log('  1. DUPLICATE_COUNT = 3 → 중복이 3회 발생하는지 확인');
  console.log('  2. USE_IDEMPOTENCY = true → 중복이 차단되는지 확인');
  console.log('  3. ACK_BEFORE_PROCESS = true → XACK 순서 변경 시 어떻게 되는지');
  console.log('  4. SIMULATE_CRASH = true → 크래시 후 재처리 흐름 확인');
  console.log('  5. SIMULATE_CRASH = true + USE_IDEMPOTENCY = true → 안전한 재처리 확인\n');
})();
