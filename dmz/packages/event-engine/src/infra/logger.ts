/**
 * logger — 구조화 로그 (JSON)
 *
 * 운영: LOG_LEVEL 환경변수로 레벨 제어 (debug | info | warn | error)
 * 교체: winston/pino 도입 시 이 파일만 교체하면 전체 코드 무변경.
 *
 * 사용:
 *   import { logger } from '../infra/logger';
 *   logger.info('메시지', { key: 'value' });
 *   logger.error('처리 실패', { error: err.message, requestId });
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogMeta  = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const currentLevel: LogLevel =
  (['debug', 'info', 'warn', 'error'] as LogLevel[]).includes(
    (process.env['LOG_LEVEL'] ?? 'info') as LogLevel,
  )
    ? (process.env['LOG_LEVEL'] as LogLevel)
    : 'info';

function write(level: LogLevel, message: string, meta?: LogMeta): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const entry = JSON.stringify({
    ts:      new Date().toISOString(),
    level,
    message,
    ...meta,
  });

  if (level === 'error' || level === 'warn') {
    process.stderr.write(entry + '\n');
  } else {
    process.stdout.write(entry + '\n');
  }
}

export const logger = {
  debug: (message: string, meta?: LogMeta) => write('debug', message, meta),
  info:  (message: string, meta?: LogMeta) => write('info',  message, meta),
  warn:  (message: string, meta?: LogMeta) => write('warn',  message, meta),
  error: (message: string, meta?: LogMeta) => write('error', message, meta),
};
