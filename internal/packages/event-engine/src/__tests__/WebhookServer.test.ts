import http from 'http';
import crypto from 'crypto';
import { WebhookServer, WebhookPayload } from '../webhook/WebhookServer';

const SECRET = 'test-secret';
const PORT   = 13000;

function makeSignature(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
}

function sendRequest(opts: {
  body:      string;
  signature: string;
  port?:     number;
}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const port = opts.port ?? PORT;
    const req = http.request(
      { hostname: 'localhost', port, method: 'POST', headers: {
        'content-type':      'application/json',
        'x-kyobo-signature': opts.signature,
        'content-length':    Buffer.byteLength(opts.body),
      }},
      res => resolve({ status: res.statusCode ?? 0 }),
    );
    req.on('error', reject);
    req.write(opts.body);
    req.end();
  });
}

describe('WebhookServer', () => {
  let server: WebhookServer;

  beforeAll(async () => {
    server = new WebhookServer({ port: PORT, secret: SECRET, maxBodyKb: 64 });
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  it('올바른 서명 → 202 응답', async () => {
    const body = JSON.stringify({ eventType: 'WALK_GOAL_MET', data: {}, timestamp: Date.now(), requestId: 'req-1' });
    const { status } = await sendRequest({ body, signature: makeSignature(body) });
    expect(status).toBe(202);
  });

  it('잘못된 서명 → 401 응답', async () => {
    const body = JSON.stringify({ eventType: 'WALK_GOAL_MET', data: {}, timestamp: Date.now(), requestId: 'req-2' });
    const { status } = await sendRequest({ body, signature: 'deadbeef' });
    expect(status).toBe(401);
  });

  it('서명 헤더 없음 → 401 응답', async () => {
    const body = JSON.stringify({ eventType: 'WALK_GOAL_MET', data: {}, timestamp: Date.now(), requestId: 'req-3' });
    const { status } = await sendRequest({ body, signature: '' });
    expect(status).toBe(401);
  });

  it('핸들러 등록 → 이벤트 수신', async () => {
    const received: WebhookPayload[] = [];
    server.on('TEST_EVENT', async payload => { received.push(payload); });

    const body = JSON.stringify({ eventType: 'TEST_EVENT', data: { foo: 'bar' }, timestamp: 1000, requestId: 'req-4' });
    await sendRequest({ body, signature: makeSignature(body) });

    await new Promise(r => setTimeout(r, 50));  // 핸들러 비동기 처리 대기
    expect(received).toHaveLength(1);
    expect(received[0]!.data).toEqual({ foo: 'bar' });
  });

  it('등록 안 된 이벤트 타입 → 202 (핸들러 없이 무시)', async () => {
    const body = JSON.stringify({ eventType: 'UNKNOWN_EVENT', data: {}, timestamp: Date.now(), requestId: 'req-5' });
    const { status } = await sendRequest({ body, signature: makeSignature(body) });
    expect(status).toBe(202);
  });

  it('GET 요청 → 405 응답', async () => {
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: PORT, method: 'GET' },
        res => resolve({ status: res.statusCode ?? 0 }),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });
});
