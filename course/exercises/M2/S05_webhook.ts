/**
 * S05 실습 — WebhookServer 기동
 *
 * 강의 노트 M2_S5_webhook_202_pattern.md Step 2 참고
 *
 * 실행 방법:
 *   npx ts-node src/exercises/S05_webhook.ts
 *
 * 테스트 방법 (Step 3):
 *   npx ts-node src/exercises/S05_make_sig.ts  ← 서명 생성
 *   생성된 PowerShell 명령어로 직접 전송
 */

import { WebhookServer } from '../webhook/WebhookServer';

const server = new WebhookServer({
  port:      3001,
  secret:    'dev-secret-kyobo',
  maxBodyKb: 64,
});

// ── 실습 1: NFT_ISSUED 핸들러를 등록하라 ────────────────────────────────────
// server.on('NFT_ISSUED', async (payload) => { ... }) 형태로 등록한다.
// 핸들러 안에서 해야 할 일:
//   1. payload를 JSON.stringify로 콘솔 출력
//   2. 200ms 슬립 (처리 시뮬레이션) — await new Promise(r => setTimeout(r, 200))
//   3. '[handler] NFT_ISSUED processed' 로그 출력
//
// 힌트: server.on(eventType, async (payload) => { ... })
throw new Error('TODO: server.on()으로 NFT_ISSUED 핸들러를 등록하세요');

(async () => {
  await server.listen();
  console.log('WebhookServer ready on :3001');
})();
