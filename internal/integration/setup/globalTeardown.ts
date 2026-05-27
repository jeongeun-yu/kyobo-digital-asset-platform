import { unlinkSync } from 'fs';
import { STATE_FILE } from './globalSetup';

export default async function globalTeardown() {
  await global.__PG_CONTAINER__?.stop().catch(() => {});
  try { unlinkSync(STATE_FILE); } catch {}
  console.log('\n[integration] 통합 테스트 종료');
}
