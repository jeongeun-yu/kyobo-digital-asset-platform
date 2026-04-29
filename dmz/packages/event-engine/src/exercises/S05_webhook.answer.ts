/**
 * S05 답안 — WebhookServer 기동
 * 강의 노트 M2_S5_webhook_202_pattern.md Step 2 답안
 */

import { WebhookServer } from '../webhook/WebhookServer';

const server = new WebhookServer({
  port:      3001,
  secret:    'dev-secret-kyobo',
  maxBodyKb: 64,
});

// TODO 1 답안: NFT_ISSUED 핸들러
server.on('NFT_ISSUED', async (payload) => {
  console.log('[handler] NFT_ISSUED received:', JSON.stringify(payload, null, 2));
  await new Promise(r => setTimeout(r, 200));
  console.log('[handler] NFT_ISSUED processed');
});

// TODO 2 답안: listen
(async () => {
  await server.listen();
  console.log('WebhookServer ready on :3001');
})();
