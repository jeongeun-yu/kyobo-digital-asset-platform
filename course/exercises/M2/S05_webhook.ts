/**
 * S05 실습 — WebhookServer 기동
 *
 * 강의 노트 M2_S5_webhook_202_pattern.md Step 2 참고
 *
 * 실행 방법 (루트에서): npm run exercise:s05
 *
 * 테스트 방법 (Step 3):
 *   npm run exercise:s05-sig  ← 서명 생성
 *   생성된 PowerShell 명령어로 직접 전송
 */

import { WebhookServer } from '@kyobo/event-engine';

const server = new WebhookServer({
  port:      3001,
  secret:    'dev-secret-kyobo',
  maxBodyKb: 64,
});

server.on('NFT_ISSUED', async (payload) => {
  console.log('[handler] NFT_ISSUED received:', JSON.stringify(payload, null, 2));
  await new Promise(r => setTimeout(r, 200));
  console.log('[handler] NFT_ISSUED processed');
});

(async () => {
  await server.listen();
  console.log('WebhookServer ready on :3001');
})();
