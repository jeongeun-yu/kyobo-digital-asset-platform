/**
 * S11 실습 — Dead Letter Queue 운영 패턴
 *
 * 실행 방법: npm run exercise:s11
 *
 * 실습 흐름:
 *   Part 1 — 3가지 실패 시나리오를 DLQ에 직접 적재 (move() 호출)
 *   Part 2 — listPending()으로 DLQ 조회 · reason 확인
 *   Part 3 — 학생 구현: reason별 requeue / drop / hold 판단 후 처리
 *   Part 4 — 처리 결과 검증 + 재투입된 필드 직접 확인
 *
 * 검증 방법:
 *   redis-cli -u "redis://:yv7ET7dkwRhoQcrxhVfq6jg3dGz69Zj2@redis-19365.c245.us-east-1-3.ec2.cloud.redislabs.com:19365"
 *   > XRANGE kyobo:exercise:s11:dlq - +
 *   > XRANGE kyobo:exercise:s11 - +
 */

// ══════════════════════════════════════════════════════════════════
//  TODO 영역 — 여기만 수정하세요
// ══════════════════════════════════════════════════════════════════

import { DLQHandler, type DLQItem } from '@kyobo/event-engine';
import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';

// .env 로드 (dotenv 없이)
const envPath = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1]!.trim()] ??= match[2]!.split('#')[0]!.trim();
  }
}

const REDIS_URL      = process.env['REDIS_URL'];
const REDIS_PASSWORD = process.env['REDIS_PASSWORD'];
if (!REDIS_URL) throw new Error('.env에 REDIS_URL이 설정되지 않았습니다. S11_guide.md 사전 준비 섹션을 확인하세요.');
const STREAM_KEY = 'kyobo:exercise:s11';
const GROUP_NAME = 's11-consumers';

// ── TODO ①: 아래 함수를 완성하세요 ────────────────────────────────
/**
 * DLQ 항목을 reason 기준으로 분류합니다.
 *
 * 판단 기준:
 *   - 'timeout' 포함        → 일시적 장애, 복구됨 → 'requeue'
 *   - 'parse error' 포함    → 코드 버그, 수정 필요 → 'hold'
 *   - 'permanently' 포함    → 영구 거부, 재시도 무의미 → 'drop'
 */
function classifyItem(item: DLQItem): 'requeue' | 'drop' | 'hold' {
  // TODO: item.reason을 보고 'requeue' | 'drop' | 'hold' 중 하나를 반환하세요
  if (item.reason.includes('timeout')) return 'requeue';
  if (item.reason.includes('permanently')) return 'drop';
  return 'hold';
}

// ── TODO ②: 아래 처리 루프를 완성하세요 ──────────────────────────
async function processClassified(
  pending:    DLQItem[],
  dlqHandler: DLQHandler,
): Promise<void> {
  for (const item of pending) {
    const action = classifyItem(item);
    const tag = `[${item.event['eventType']}] userId=${item.event['userId']}`;

    if (action === 'requeue') {
      // TODO: dlqHandler.requeueMessage(item.messageId) 호출 후 결과 출력
      // 힌트: const { newMessageId } = await dlqHandler.requeueMessage(...)
      const { newMessageId } = await dlqHandler.requeueMessage(item.messageId);
      console.log(`  ♻  REQUEUE ${tag} → newMessageId: ${newMessageId}`);
    } else if (action === 'drop') {
      // TODO: dlqHandler.drop(item.messageId) 호출
      // 힌트: drop()은 DLQ에서 메시지를 영구 삭제합니다
      await dlqHandler.drop(item.messageId);
      console.log(`  🗑  DROP   ${tag} → DLQ에서 영구 삭제`);
    } else {
      console.log(`  ⏸  HOLD   ${tag} → 코드 수정 후 재판단 필요`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  아래는 수정하지 않아도 됩니다
// ══════════════════════════════════════════════════════════════════

function makeRedisAdapter(r: Redis) {
  function parseFields(raw: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i]; const v = raw[i + 1];
      if (k !== undefined && v !== undefined) out[k] = v;
    }
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = r as any;
  return {
    async xadd(key: string, fields: Record<string, string>): Promise<string> {
      return a.xadd(key, '*', ...Object.entries(fields).flat());
    },
    async xrange(key: string, start: string, end: string, count?: number) {
      const args = count != null ? [key, start, end, 'COUNT', String(count)] : [key, start, end];
      const raw: Array<[string, string[]]> = await a.xrange(...args);
      return raw.map(([id, f]) => ({ id, fields: parseFields(f) }));
    },
    async xdel(key: string, ...ids: string[]): Promise<number> {
      return r.xdel(key, ...ids);
    },
  };
}

// 3가지 실패 시나리오 (move()로 DLQ에 직접 적재)
function makeScenarios(): Omit<DLQItem, 'messageId'>[] {
  return [
    {
      streamKey: STREAM_KEY,
      groupName: GROUP_NAME,
      event: { eventType: 'NFT_ISSUED', userId: 'user-001', tokenId: '0x1a' },
      reason:   'BigInt parse error: Cannot convert 0x1a to a BigInt',
      failedAt: new Date(Date.now() - 10 * 60 * 1000),
    },
    {
      streamKey: STREAM_KEY,
      groupName: GROUP_NAME,
      event: { eventType: 'NFT_ISSUED', userId: 'user-002', tokenId: '42', txHash: '0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1' },
      reason:   'VASP connection timeout after 30s — 장애 복구 완료',
      failedAt: new Date(Date.now() - 5 * 60 * 1000),
    },
    {
      streamKey: STREAM_KEY,
      groupName: GROUP_NAME,
      event: { eventType: 'NFT_ISSUED', userId: 'user-003', tokenId: '7' },
      reason:   'KYC permanently rejected: user-003 on compliance blacklist',
      failedAt: new Date(Date.now() - 1 * 60 * 1000),
    },
  ];
}

async function seedDLQ(dlqHandler: DLQHandler): Promise<void> {
  console.log('\n  Part 1 — DLQ 시나리오 적재 (move() 호출)\n');
  for (const scenario of makeScenarios()) {
    const dlqId = await dlqHandler.move({ ...scenario, messageId: `${Date.now()}-${Math.random().toString(36).slice(2,5)}` });
    console.log(`  ✦ DLQ 적재: ${scenario.event['userId']} | ${scenario.reason.slice(0, 45)}...`);
    console.log(`    dlqId = ${dlqId}`);
  }
}

(async () => {
  const LINE = '─'.repeat(60);
  console.log('\n' + LINE);
  console.log('  S11 실습 — DLQ 운영 패턴 (Real Redis)');
  console.log(LINE);

  const [host, portStr] = REDIS_URL.split(':');
  const redis = new Redis({ host, port: parseInt(portStr ?? '6379', 10), password: REDIS_PASSWORD, lazyConnect: true });
  await redis.connect();

  // 이전 실행 데이터 초기화
  await redis.del(`${STREAM_KEY}:dlq`, STREAM_KEY);

  const adapter    = makeRedisAdapter(redis);
  const dlqHandler = new DLQHandler(adapter, { async sendAlert() {} }, STREAM_KEY);

  // Part 1
  await seedDLQ(dlqHandler);

  // Part 2 — DLQ 조회
  console.log('\n' + LINE);
  console.log('  Part 2 — DLQ 현황 조회 (listPending())\n');
  const pending = await dlqHandler.listPending();
  console.log(`  DLQ 항목 수: ${pending.length}건\n`);
  for (const item of pending) {
    console.log(`  ┌─ messageId : ${item.messageId}`);
    console.log(`  │  eventType : ${item.event['eventType']}`);
    console.log(`  │  userId    : ${item.event['userId']}`);
    console.log(`  │  reason    : ${item.reason}`);
    console.log(`  └─ failedAt  : ${item.failedAt.toISOString()}\n`);
  }

  // Part 3 — 학생 구현
  console.log(LINE);
  console.log('  Part 3 — requeue / drop / hold 판단 및 처리\n');
  try {
    await processClassified(pending, dlqHandler);
  } catch (e) {
    console.log(`  ⚠  미구현: ${(e as Error).message}`);
    console.log('     → TODO ① · ② 를 완성하고 다시 실행하세요\n');
    await redis.quit();
    return;
  }

  // Part 4 — 검증
  console.log('\n' + LINE);
  console.log('  Part 4 — 처리 결과 검증\n');

  const dlqAfter = await dlqHandler.listPending();
  console.log(`  DLQ 잔류: ${dlqAfter.length}건 (requeue·drop 제외, hold만 남아있어야 함)`);

  // 재투입된 메시지 필드 확인
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requeuedRaw: Array<[string, string[]]> = await (redis as any).xrange(STREAM_KEY, '-', '+');
  if (requeuedRaw.length > 0) {
    console.log(`\n  원 스트림(${STREAM_KEY}) 재투입 메시지:\n`);
    for (const [id, fields] of requeuedRaw) {
      const map: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const k = fields[i]; const v = fields[i+1];
        if (k && v) map[k] = v;
      }
      console.log(`  ┌─ messageId      : ${id}`);
      for (const [k, v] of Object.entries(map)) {
        const tag = k.startsWith('_') ? '[추적메타]' : '[비즈니스]';
        console.log(`  │  ${tag} ${k.padEnd(20)} = ${v}`);
      }
      console.log('  └─');
    }
  }

  console.log('\n  redis-cli로 직접 확인:');
  console.log(`  > XRANGE ${STREAM_KEY}:dlq - +`);
  console.log(`  > XRANGE ${STREAM_KEY} - +`);
  console.log('\n' + LINE + '\n');

  await redis.quit();
})();
