import { readFileSync } from 'fs';
import { STATE_FILE }   from '../setup/globalSetup';

interface IntegrationState {
  pgUrl:       string;
  containerId: string;
}

function readState(): IntegrationState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}

export function getPgUrl(): string {
  return readState().pgUrl;
}

export function getRedisUrl(): string {
  const url      = process.env.REDIS_URL;
  const password = process.env.REDIS_PASSWORD;

  if (!url) throw new Error('REDIS_URL 환경변수가 없습니다.');

  // 이미 프로토콜이 붙어있으면 그대로 사용
  if (url.startsWith('redis://') || url.startsWith('rediss://')) return url;

  // host:port 형식이면 REDIS_PASSWORD로 조합
  if (password) return `redis://:${password}@${url}`;

  return `redis://${url}`;
}
