import type { IInternalLedgerClient, AuditLogParams } from '../interfaces/IInternalLedgerClient';

export class HttpInternalLedgerClient implements IInternalLedgerClient {
  constructor(private readonly baseUrl: string) {}

  async recordAuditLog(params: AuditLogParams): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/internal/audit-log`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          ...params,
          beforeState: params.beforeState != null ? JSON.stringify(params.beforeState) : null,
          afterState:  JSON.stringify(params.afterState),
        }),
      });
      if (!res.ok) {
        console.error(`[HttpInternalLedgerClient] audit-log 실패: HTTP ${res.status}`);
      }
    } catch (e) {
      console.error(`[HttpInternalLedgerClient] audit-log 요청 오류:`, (e as Error).message);
    }
  }
}
