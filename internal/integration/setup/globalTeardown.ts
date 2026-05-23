import { readFileSync, unlinkSync } from 'fs';
import { execSync }                from 'child_process';
import { STATE_FILE }              from './globalSetup';

export default async function globalTeardown() {
  try {
    const { containerId } = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    execSync(`docker stop ${containerId}`, { stdio: 'ignore' });
    execSync(`docker rm  ${containerId}`, { stdio: 'ignore' });
    console.log('\n[integration] PostgreSQL 컨테이너 종료');
  } catch {
    // Ryuk reaper가 이미 정리했을 수 있음
  } finally {
    try { unlinkSync(STATE_FILE); } catch {}
  }
}
