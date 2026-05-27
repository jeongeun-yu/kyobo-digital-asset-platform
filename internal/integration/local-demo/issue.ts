/**
 * local-demo/issue.ts — 발행 요청 CLI
 *
 * 실행: npx ts-node --project ../integration/tsconfig.json local-demo/issue.ts [userId] [steps]
 * (또는 integration package.json의 demo:issue 스크립트)
 *
 * start.ts로 서버가 떠 있는 상태에서 실행한다.
 * HMAC 서명된 ACTIVITY_ACHIEVED 웹훅을 WebhookServer에 전송한다.
 */

import http           from 'http';
import crypto         from 'crypto';
import { randomUUID } from 'crypto';

const WEBHOOK_PORT   = 19877;
const WEBHOOK_SECRET = 'local-demo-webhook-secret-32ch!!';
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

console.log(`\n[issue] userId=${userId}  steps=${steps}`);
console.log(`[issue] requestId=${payload.requestId}`);
console.log(`[issue] POST http://localhost:${WEBHOOK_PORT} ...`);

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
    console.log(`[issue] HTTP ${res.statusCode}`);
    if (res.statusCode === 202) {
      console.log(`
[issue] 202 Accepted — 파이프라인 처리 중
  start.ts 콘솔에서 로그 확인:
    [VASPServer] → TX 브로드캐스트 → Hardhat 블록 채굴
    [VASPServer] → NFT_ISSUED 콜백
    [ConsumerGroupWorker] → Redis Stream 소비
    [TxTransitionBridge] → issuance_requests CONFIRMED
`);
    } else if (res.statusCode === 401) {
      console.error('[issue] 401 — HMAC 서명 불일치 (WEBHOOK_SECRET 확인)');
    } else {
      console.error(`[issue] 예상치 못한 응답: ${res.statusCode}`);
    }
  },
);

req.on('error', err => {
  console.error('[issue] 연결 실패 — start.ts가 실행 중인지 확인하세요:', err.message);
});

req.write(body);
req.end();
