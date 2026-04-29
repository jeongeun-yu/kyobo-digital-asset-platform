import http from 'http';
import crypto from 'crypto';
import { logger } from '../infra/logger';

/**
 * WebhookServer — 외부 시스템(교보 core banking 등)으로부터 Webhook 수신
 *
 * 보안:
 *   - HMAC-SHA256 서명 검증 — 위변조 이벤트 거부
 *   - timingSafeEqual 비교 — Timing Attack 방지
 *   - rawBody(Buffer)로 서명 계산 — 재직렬화 함정 방지
 *   - 길이 불일치 사전 차단 — timingSafeEqual length mismatch throw 방지
 *   - 요청 body 크기 제한 — payload injection 방지
 *
 * 신뢰성:
 *   - 수신 즉시 202 응답 (처리 전) → 발신자 timeout 방지
 *   - 실제 처리는 핸들러 체인으로 비동기 위임
 *   - IdempotencyGuard와 함께 사용 → 중복 수신 안전
 *
 * ## HMAC 서명 검증 설계 원칙
 *
 * 함정 1 — rawBody vs 재직렬화 객체:
 *   JSON.parse() 후 JSON.stringify()로 재직렬화하면 키 순서·공백이 달라질 수 있다.
 *   서명은 반드시 수신한 원본 바이트(rawBody Buffer)로 계산해야 발신측 서명과 일치한다.
 *
 * 함정 2 — timingSafeEqual 길이 불일치:
 *   crypto.timingSafeEqual()은 두 Buffer 길이가 다르면 예외를 던진다.
 *   길이를 사전에 비교해야 한다. 단, 일반 length 비교는 timing safe하지 않아도 무관:
 *   길이 자체는 signature 헤더 값으로 공개되어 있으므로 secret이 누출되지 않는다.
 *
 * 함정 3 — 일반 문자열 비교 (=== / .equals()):
 *   첫 번째 다른 문자를 만나면 즉시 false 반환 → 응답 시간으로 서명 추측 가능 (Timing Attack).
 *   timingSafeEqual은 길이가 같으면 항상 동일 시간에 비교한다.
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
        logger.info('WebhookServer listening', { port: this.config.port });
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
      // rawBody를 Buffer로 유지 — 서명 계산을 원본 바이트로 수행
      const rawBody = await this._readBody(req);
      const signature = req.headers['x-kyobo-signature'] as string ?? '';

      if (!this._verifySignature(rawBody, signature)) {
        res.writeHead(401).end('invalid signature');
        return;
      }

      // 서명 검증 통과 후 string으로 변환해 JSON 파싱
      const payload: WebhookPayload = JSON.parse(rawBody.toString('utf8'));

      // 즉시 202 응답 — 발신자 timeout 방지
      res.writeHead(202).end();

      const handlers = this.handlers.get(payload.eventType) ?? [];
      await Promise.allSettled(handlers.map(h => h(payload)));

    } catch (err) {
      if (!res.headersSent) res.writeHead(400).end();
      logger.error('WebhookServer request error', { error: (err as Error).message });
    }
  }

  // rawBody를 Buffer로 반환 — string 변환 없이 원본 바이트 보존
  private _readBody(req: http.IncomingMessage): Promise<Buffer> {
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
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /**
   * HMAC-SHA256 서명 검증.
   *
   * @param rawBody - 수신한 원본 바이트 (Buffer). JSON.parse 전 원본 사용.
   * @param signature - X-Kyobo-Signature 헤더 값 (hex string).
   *
   * 설계 포인트:
   *   1. rawBody Buffer로 HMAC 계산 — JSON 재직렬화 함정 회피
   *   2. 길이 불일치 사전 차단 — timingSafeEqual이 throw하는 상황 방지
   *   3. timingSafeEqual — Timing Attack 방지
   */
  private _verifySignature(rawBody: Buffer, signature: string): boolean {
    if (!signature) return false;

    const expected = crypto
      .createHmac('sha256', this.config.secret)
      .update(rawBody)        // string 재직렬화 없이 원본 Buffer로 계산
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected,  'hex');

    // 길이 불일치 → timingSafeEqual이 throw하므로 사전 차단
    // (signature 헤더 길이는 공개 정보 — 이 비교 자체는 timing safe 불필요)
    if (sigBuf.length !== expBuf.length) return false;

    // 항상 동일 시간에 비교 — Timing Attack 방지
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }
}
