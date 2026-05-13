/**
 * gracefulShutdown — SIGTERM / SIGINT 처리
 *
 * 사용:
 *   import { registerShutdown } from '../infra/gracefulShutdown';
 *
 *   registerShutdown(async () => {
 *     worker.stop();
 *     await workerPromise;
 *     await server.close();
 *   });
 *
 * 동작:
 *   - SIGTERM / SIGINT 수신 → 등록된 핸들러 순서대로 실행
 *   - SHUTDOWN_TIMEOUT_MS(기본 10초) 초과 시 강제 종료
 *   - 이미 종료 중이면 중복 신호 무시
 */

import { logger } from './logger';

const TIMEOUT_MS = Number(process.env['SHUTDOWN_TIMEOUT_MS'] ?? 10_000);

let shuttingDown = false;
const handlers: Array<() => Promise<void>> = [];

export function registerShutdown(handler: () => Promise<void>): void {
  handlers.push(handler);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('shutdown signal received', { signal });

  const timer = setTimeout(() => {
    logger.error('graceful shutdown timeout — forcing exit', { timeoutMs: TIMEOUT_MS });
    process.exit(1);
  }, TIMEOUT_MS);

  try {
    for (const handler of handlers) {
      await handler();
    }
    clearTimeout(timer);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    clearTimeout(timer);
    logger.error('shutdown error', { error: (err as Error).message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT');  });
