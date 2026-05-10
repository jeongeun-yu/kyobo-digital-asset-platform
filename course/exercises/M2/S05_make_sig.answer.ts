/**
 * S05 실습 — HMAC 서명 생성 스크립트 (Step 3용)
 *
 * 실행: npx tsx src/exercises/S05_make_sig.ts
 */

import crypto from 'crypto';

export function computeHmac(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(Buffer.from(payload)).digest('hex');
}

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
