import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool }                from 'pg';
import { writeFileSync, readFileSync } from 'fs';
import { resolve }             from 'path';
import { config as loadEnv }   from 'dotenv';

// .env 명시적 로드 — jest 실행 위치에 무관하게 동작
loadEnv({ path: resolve(__dirname, '..', '..', '..', '..', '.env') });

export const STATE_FILE = resolve(__dirname, '..', '.integration-state.json');

export default async function globalSetup() {
  console.log('\n[integration] PostgreSQL 컨테이너 시작 중...');

  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('kyobo_test')
    .withUsername('kyobo')
    .withPassword('kyobo')
    .start();

  const pgUrl = container.getConnectionUri();
  console.log(`[integration] PostgreSQL 준비 완료`);

  // 스키마 생성
  const pool = new Pool({ connectionString: pgUrl });
  try {
    const sql = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
    await pool.query(sql);
    console.log('[integration] 스키마 생성 완료');
  } finally {
    await pool.end();
  }

  // 상태 파일 저장 — teardown + 각 테스트 파일에서 참조
  writeFileSync(STATE_FILE, JSON.stringify({
    pgUrl,
    containerId: container.getId(),
  }));
}
