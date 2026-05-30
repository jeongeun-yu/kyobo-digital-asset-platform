/**
 * local-demo/issue-sepolia.ts — Sepolia 데모 발행 요청 CLI
 *
 * 실행: npm run demo:issue-sepolia   (internal/integration/)
 *
 * start-sepolia.ts로 서버가 떠 있는 상태에서 실행한다.
 * HMAC 서명된 ACTIVITY_ACHIEVED 웹훅을 WebhookServer에 전송한다.
 *
 * ⚠ Sepolia 블록 확정 ~12s — NFT_ISSUED 콜백까지 20~30초 소요 정상
 */

import http           from 'http';
import crypto         from 'crypto';
import { randomUUID } from 'crypto';

const WEBHOOK_PORT    = 19887;
const WEBHOOK_SECRET  = 'sepolia-demo-webhook-secret-32ch!!';
const TEST_EVENT_TYPE = 'WALK_GOAL_MET';

const userId = process.argv[2] ?? 'demo-user-001';
const steps  = Number(process.argv[3] ?? 15_000);

const payload = {
  eventType:  'ACTIVITY_ACHIEVED',
  requestId:  randomUUID(),
  timestamp:  Date.now(),
  data: {
    userId,
    activityId: randomUUID(),
    eventType:  TEST_EVENT_TYPE,
    eventCode:  1,
    data:       { steps },
  },
};

const body = JSON.stringify(payload);
const sig  = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

console.log(`\n[issue-sepolia] userId=${userId}  steps=${steps}`);
console.log(`[issue-sepolia] requestId=${payload.requestId}`);
console.log(`[issue-sepolia] POST http://localhost:${WEBHOOK_PORT} ...`);

const req = http.request(
  {
    hostname: 'localhost',
    port:     WEBHOOK_PORT,
    method:   'POST',
    headers:  {
      'Content-Type':       'application/json',
      'Content-Length':     Buffer.byteLength(body),
      'x-kyobo-signature':  sig,
    },
  },
  res => {
    console.log(`[issue-sepolia] HTTP ${res.statusCode}`);
    if (res.statusCode === 202) {
      console.log(`
[issue-sepolia] 202 Accepted — 파이프라인 처리 중
  ⚠ Sepolia 블록 확정 ~12s — 아래 단계까지 20~30초 소요 정상

  start-sepolia.ts 콘솔에서 로그 확인:
    [VASPServer] → TX 브로드캐스트 → Sepolia TX 해시 반환
    [VASPServer] → tx.wait(1) 대기 (블록 확정 ~12s)
    [VASPServer] → NFT_ISSUED 콜백
    [ConsumerGroupWorker] → Redis Stream 소비
    [TxTransitionBridge] → issuance_requests CONFIRMED
    [audit_log] → SHA-256 체인 기록
`);
    } else if (res.statusCode === 401) {
      console.error('[issue-sepolia] 401 — HMAC 서명 불일치 (WEBHOOK_SECRET 확인)');
    } else {
      console.error(`[issue-sepolia] 예상치 못한 응답: ${res.statusCode}`);
    }
  },
);

req.on('error', err => {
  console.error('[issue-sepolia] 연결 실패 — start-sepolia.ts가 실행 중인지 확인:', err.message);
});

req.write(body);
req.end();
