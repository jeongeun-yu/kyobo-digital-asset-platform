import { writeFileSync }       from 'fs';
import { resolve }             from 'path';
import { config as loadEnv }   from 'dotenv';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync }        from 'fs';
import { Pool }                from 'pg';

// .env 명시적 로드 — jest 실행 위치에 무관하게 동작
loadEnv({ path: resolve(__dirname, '..', '..', '..', '.env') });

export const STATE_FILE = resolve(__dirname, '..', '.integration-state.json');

// globalSetup이 띄운 공유 PG 컨테이너 ID — globalTeardown에서 종료
declare global {
  // eslint-disable-next-line no-var
  var __PG_CONTAINER__: import('testcontainers').StartedTestContainer | undefined;
}

export default async function globalSetup() {
  console.log('\n[integration] 통합 테스트 시작');

  // 공유 PostgreSQL 컨테이너 — walkthrough / e2e / issuance-status 테스트용
  // mock-vasp / Sepolia 테스트는 각 beforeAll에서 자체 컨테이너를 별도 관리
  const pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('kyobo_test')
    .withUsername('kyobo')
    .withPassword('kyobo')
    .start();

  const pgUrl = pgContainer.getConnectionUri();

  // 스키마 적용
  const pool = new Pool({ connectionString: pgUrl });
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  await pool.query(schema);
  await pool.end();

  // globalTeardown에서 컨테이너를 종료할 수 있도록 전역 참조 저장
  global.__PG_CONTAINER__ = pgContainer;

  // helpers/state.ts를 통해 테스트 파일들이 pgUrl을 읽을 수 있게 기록
  writeFileSync(STATE_FILE, JSON.stringify({ pgUrl, containerId: pgContainer.getId() }));

  console.log(`[integration] 공유 PostgreSQL 준비 완료 → ${pgUrl}`);
}
