/**
 * S05 실습 — HMAC 서명 생성 스크립트 (Step 3용)
 *
 * 실행: npx ts-node src/exercises/S05_make_sig.ts
 *
 * 목표:
 *   crypto.createHmac을 사용해 HMAC-SHA256 서명을 계산하고 콘솔에 출력한다.
 *
 * 힌트:
 *   crypto.createHmac('sha256', secret)
 *         .update(Buffer.from(data))
 *         .digest('hex')
 */

import crypto from 'crypto';

const payload = JSON.stringify({
  eventType: 'NFT_ISSUED',
  data:      { tokenId: '42', owner: '0xABCD' },
  timestamp: Date.now(),
  requestId: 'test-001',
});

const sig = crypto
  .createHmac('sha256', 'dev-secret-kyobo')
  .update(Buffer.from(payload))
  .digest('hex');

console.log('signature:', sig);
console.log('payload:  ', payload);

console.log('\n--- [올바른 서명] PowerShell 명령어 → 202 기대 ---');
console.log(`Invoke-WebRequest -Uri http://localhost:3001 -Method POST \`
  -Headers @{ "Content-Type" = "application/json"; "X-Kyobo-Signature" = "${sig}" } \`
  -Body '${payload}' | Select-Object -ExpandProperty StatusCode`);

console.log('\n--- [잘못된 서명] PowerShell 명령어 → 401 기대 ---');
console.log(`Invoke-WebRequest -Uri http://localhost:3001 -Method POST \`
  -Headers @{ "Content-Type" = "application/json"; "X-Kyobo-Signature" = "0000000000000000" } \`
  -Body '${payload}' | Select-Object -ExpandProperty StatusCode`);
