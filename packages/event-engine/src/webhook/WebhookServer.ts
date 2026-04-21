import http from 'http';
import crypto from 'crypto';

/**
 * WebhookServer — 외부 시스템(교보 core banking 등)으로부터 Webhook 수신
 *
 * 보안:
 *   - HMAC-SHA256 서명 검증 — 위변조 이벤트 거부
 *   - 요청 body 크기 제한 — payload injection 방지
 *
 * 신뢰성:
 *   - 수신 즉시 202 응답 (처리 전) → 발신자 timeout 방지
 *   - 실제 처리는 핸들러 체인으로 비동기 위임
 *   - IdempotencyGuard와 함께 사용 → 중복 수신 안전
 */

export type WebhookPayload = {
  eventType: string;
  data:      Record<string, unknown>;
  timestamp: number;
  requestId: string;  // 멱등성 키
};

export type WebhookHandler = (payload: WebhookPayload) => Promise<void>;

export class WebhookServer {
  private server: http.Server;
  private handlers: Map<string, WebhookHandler[]> = new Map();

  constructor(private readonly config: {
    port:       number;
    secret:     string;   // HMAC 검증 시크릿 (환경 변수로 주입)
    maxBodyKb:  number;
  }) {
    this.server = http.createServer(this._handleRequest.bind(this));
  }

  on(eventType: string, handler: WebhookHandler): this {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
    return this;
  }

  listen(): Promise<void> {
    return new Promise(resolve =>
      this.server.listen(this.config.port, () => {
        console.log(`[WebhookServer] listening on :${this.config.port}`);
        resolve();
      }),
    );
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close(err => err ? reject(err) : resolve()),
    );
  }

  private async _handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    try {
      const body = await this._readBody(req);

      if (!this._verifySignature(body, req.headers['x-kyobo-signature'] as string)) {
        res.writeHead(401).end('invalid signature');
        return;
      }

      const payload: WebhookPayload = JSON.parse(body);

      // 즉시 202 응답 — 발신자 timeout 방지
      res.writeHead(202).end();

      const handlers = this.handlers.get(payload.eventType) ?? [];
      await Promise.allSettled(handlers.map(h => h(payload)));

    } catch (err) {
      if (!res.headersSent) res.writeHead(400).end();
      console.error('[WebhookServer] error:', err);
    }
  }

  private _readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.config.maxBodyKb * 1024) {
          reject(new Error('payload too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private _verifySignature(body: string, signature: string): boolean {
    if (!signature) return false;
    const expected = crypto
      .createHmac('sha256', this.config.secret)
      .update(body)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  }
}
