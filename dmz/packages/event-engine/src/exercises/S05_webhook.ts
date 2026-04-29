/**
 * S05 실습 — WebhookServer 기동
 *
 * 강의 노트 M2_S5_webhook_202_pattern.md Step 2 참고
 *
 * 실행 방법:
 *   npx ts-node --esm src/exercises/S05_webhook.ts
 *
 * 테스트 방법 (Step 3):
 *   node src/exercises/S05_make_sig.cjs  ← 서명 생성
 *   curl 명령어로 직접 전송
 */

import { WebhookServer } from '../webhook/WebhookServer';

const server = new WebhookServer({
  port:      3001,
  secret:    'dev-secret-kyobo',
  maxBodyKb: 64,
});

// TODO 1: 'NFT_ISSUED' 이벤트 핸들러 등록
//         - payload를 JSON으로 콘솔 출력
//         - 200ms 슬립 (처리 시뮬레이션)
//         - 처리 완료 로그 출력
server.on('NFT_ISSUED', async (payload) => {
  console.log('[handler] NFT_ISSUED received:', JSON.stringify(payload, null, 2));
  await new Promise(r => setTimeout(r, 200));
  console.log('[handler] NFT_ISSUED processed');
});

(async () => {
  await server.listen();
  console.log('WebhookServer ready on :3001');
})();
