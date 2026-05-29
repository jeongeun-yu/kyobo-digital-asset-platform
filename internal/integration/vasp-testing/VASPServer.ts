/**
 * VASPServer — 통합 테스트용 VASP HTTP 서버
 *
 * 실제 외부 VASP(월렛원 등)가 제공하는 REST API를 구현한다.
 * ExternalVASPAdapter → POST /transactions → 서명 → 블록체인 브로드캐스트
 * TX 확정 후 내부 WebhookServer로 NFT_ISSUED 콜백을 전송한다.
 *
 * 엔드포인트:
 *   POST /transactions      — TX 서명·브로드캐스트 (ExternalVASPAdapter 호출 대상)
 *   GET  /transfers/:txHash — TX 상태 조회 (ExternalVASPAdapter.getTransferStatus 호출 대상)
 *   POST /admin/mode        — MockVASP 컨트랙트 모드 전환 (테스트 시나리오 제어)
 *   GET  /admin/mode        — 현재 모드 조회
 */

import http   from 'http';
import crypto from 'crypto';
import { ethers, NonceManager } from 'ethers';
import MOCK_VASP_ABI               from './MockVASP.abi.json';
import { MINT_MODE_INDEX }         from './ChainVASPAdapterBase';
import type { MintMode }           from './ChainVASPAdapterBase';

const MODE_REVERSE: Record<number, MintMode> = { 0: 'NORMAL', 1: 'REVERT', 2: 'NO_EMIT' };

export interface VASPServerConfig {
  port:           number;
  rpcUrl:         string;
  signerKey:      string;   // TX 서명 계정 (OPERATOR_KEY)
  contractAddr:   string;   // MockVASP 컨트랙트 주소
  callbackUrl:    string;   // 콜백 대상 WebhookServer URL (예: http://localhost:19878)
  callbackSecret: string;   // HMAC-SHA256 시크릿
  pollingInterval?: number; // ethers provider 폴링 간격 ms (기본 4000, 테스트는 100 권장)
}

export class VASPServer {
  private readonly server:     http.Server;
  private readonly provider:   ethers.JsonRpcProvider;
  private readonly signer:     ethers.Signer;
  private readonly contract:   ethers.Contract;
  private readonly cfg:        VASPServerConfig;
  // txHash → 'pending' | 'completed' | 'failed' — GET /transfers/:txHash 응답용
  private readonly txStatuses = new Map<string, 'pending' | 'completed' | 'failed'>();

  constructor(config: VASPServerConfig) {
    this.cfg      = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer   = new NonceManager(new ethers.Wallet(config.signerKey, this.provider));
    this.contract = new ethers.Contract(config.contractAddr, MOCK_VASP_ABI, this.signer);

    if (config.pollingInterval !== undefined) {
      this.provider.pollingInterval = config.pollingInterval;
    }

    this.server = http.createServer((req, res) => {
      this._dispatch(req, res).catch(err => {
        console.error('[VASPServer] unhandled error:', (err as Error).message);
        if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: 'internal error' }));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.cfg.port, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    console.log(`[VASPServer] 기동 완료 → :${this.cfg.port}  contract=${this.cfg.contractAddr}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close(err => (err ? reject(err) : resolve())),
    );
  }

  // NonceManager를 체인 현재 상태와 재동기화한다.
  // beforeEach에서 호출해 이전 테스트의 TX로 인한 nonce 불일치를 방지한다.
  resetNonce(): void {
    if (this.signer instanceof NonceManager) {
      (this.signer as NonceManager).reset();
    }
  }

  // ── 라우팅 ─────────────────────────────────────────────────────────────────

  private async _dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this._readBody(req);

    if (req.method === 'POST' && req.url === '/transactions') {
      await this._handleSubmit(body, res);
    } else if (req.method === 'GET' && req.url?.startsWith('/transfers/')) {
      const txHash = req.url.slice('/transfers/'.length);
      this._handleGetTransferStatus(txHash, res);
    } else if (req.method === 'POST' && req.url === '/admin/mode') {
      await this._handleSetMode(body, res);
    } else if (req.method === 'GET' && req.url === '/admin/mode') {
      await this._handleGetMode(res);
    } else if (req.method === 'GET' && req.url?.startsWith('/aml/screen/')) {
      const address = req.url.split('/').pop() ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ address, status: 'clear', screened: true }));
    } else {
      res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
    }
  }

  // ── POST /transactions ─────────────────────────────────────────────────────
  // ExternalVASPAdapter가 호출하는 핵심 엔드포인트
  // body: { contractAddr, method, args: [to, tokenId, amount, reason], idempotencyKey }
  //
  // 처리 흐름:
  //   1. issueActivityNFT 호출 시도
  //      → REVERT 모드: eth_estimateGas 단계에서 revert → 즉시 500 반환
  //        ExternalVASPAdapter throws → IssuerService sets FAILED
  //      → NORMAL/NO_EMIT 모드: TX 브로드캐스트 성공 → txHash 포함 202 반환
  //        이후 비동기로 receipt 대기 → 콜백 전송

  private async _handleSubmit(body: string, res: http.ServerResponse): Promise<void> {
    const parsed = JSON.parse(body) as {
      method:          string;
      args:            unknown[];
      idempotencyKey?: string;
    };

    const [to, tokenId, amount, rawReason] = parsed.args as [string, unknown, unknown, string];
    const reasonHex = String(rawReason).startsWith('0x')
      ? String(rawReason).slice(2)
      : String(rawReason);
    const reason32 = ('0x' + reasonHex.padEnd(64, '0').slice(0, 64)) as `0x${string}`;

    let tx: ethers.ContractTransactionResponse;
    try {
      const fn = this.contract['issueActivityNFT'] as (
        to: unknown, tokenId: unknown, amount: unknown, reason: unknown,
      ) => Promise<ethers.ContractTransactionResponse>;
      tx = await fn(to, tokenId, amount, reason32);
    } catch (err) {
      // REVERT 모드: eth_estimateGas 단계에서 실패 → 즉시 오류 반환
      // NonceManager는 populateTransaction에서 nonce를 미리 증가시키므로
      // estimateGas 실패 시 reset()으로 카운터를 체인과 재동기화한다
      if (this.signer instanceof NonceManager) (this.signer as NonceManager).reset();
      console.log(`[VASPServer] tx 제출 실패 (REVERT): ${(err as Error).message.slice(0, 80)}`);
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ error: (err as Error).message }),
      );
      return;
    }

    // 즉시 202 반환 — ExternalVASPAdapter는 txHash를 받아 DB에 SUBMITTED로 기록
    this.txStatuses.set(tx.hash, 'pending');  // GET /transfers/:txHash 응답 준비
    res.writeHead(202, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ txHash: tx.hash, status: 'submitted', timestamp: Date.now() }),
    );

    const requestId = parsed.idempotencyKey ?? tx.hash;
    this._waitAndNotify(tx, requestId, String(tokenId), String(to)).catch(err =>
      console.error('[VASPServer] 콜백 오류:', (err as Error).message),
    );
  }

  // TX 확정 대기 → 내부 WebhookServer 콜백
  private async _waitAndNotify(
    tx:        ethers.ContractTransactionResponse,
    requestId: string,
    tokenId:   string,
    to:        string,
  ): Promise<void> {
    let receipt: ethers.TransactionReceipt | null;

    try {
      receipt = await tx.wait(1);
    } catch (err) {
      // tx.wait()가 revert exception을 던지는 경우 (드물지만 방어)
      this.txStatuses.set(tx.hash, 'failed');
      await this._postCallback('NFT_FAILED', requestId, {
        txHash: tx.hash,
        reason: (err as Error).message,
      });
      return;
    }

    if (!receipt || receipt.status === 0) {
      this.txStatuses.set(tx.hash, 'failed');
      await this._postCallback('NFT_FAILED', requestId, {
        txHash: tx.hash,
        reason: 'transaction reverted',
      });
      return;
    }

    // TX 온체인 확정 — Issued 이벤트 여부와 무관하게 completed
    this.txStatuses.set(tx.hash, 'completed');

    // Issued 이벤트 파싱
    const iface     = new ethers.Interface(MOCK_VASP_ABI as ethers.InterfaceAbi);
    const issuedLog = receipt.logs.find(l => {
      try { return iface.parseLog(l)?.name === 'Issued'; } catch { return false; }
    });

    if (!issuedLog) {
      // NO_EMIT 모드: TX 성공, 이벤트 없음 → 콜백 없음 (txStatuses는 'completed' 유지)
      console.log(`[VASPServer] NO_EMIT — tx ${tx.hash} 확정, Issued 이벤트 없음`);
      return;
    }

    const args = iface.parseLog(issuedLog)!.args;
    await this._postCallback('NFT_ISSUED', requestId, {
      txHash:      tx.hash,
      blockNumber: receipt.blockNumber,
      tokenId:     args[1].toString(),
      to:          args[0],
      reason:      args[2],
    });
  }

  // HMAC 서명 포함 콜백 전송
  private async _postCallback(
    eventType: string,
    requestId: string,
    data:      Record<string, unknown>,
  ): Promise<void> {
    const body = JSON.stringify({ eventType, requestId, timestamp: Date.now(), data });
    const sig  = crypto.createHmac('sha256', this.cfg.callbackSecret).update(body).digest('hex');

    const url = new URL(this.cfg.callbackUrl);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port:     Number(url.port || 80),
          path:     url.pathname || '/',
          method:   'POST',
          headers:  {
            'Content-Type':      'application/json',
            'Content-Length':    Buffer.byteLength(body),
            'x-kyobo-signature': sig,
          },
        },
        res => { res.resume(); res.on('end', resolve); },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    console.log(`[VASPServer] ${eventType} 콜백 전송 완료 (requestId=${requestId.slice(0, 8)}…)`);
  }

  // ── GET /transfers/:txHash ────────────────────────────────────────────────
  // ExternalVASPAdapter.getTransferStatus(txHash) 호출 대상
  // pollStaleRequests → VaspTxClientAdapter.getStatus → ExternalVASPAdapter → 이 엔드포인트

  private _handleGetTransferStatus(txHash: string, res: http.ServerResponse): void {
    const status = this.txStatuses.get(txHash);
    if (!status) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'transfer not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ txHash, status, fee: '0' }));
  }

  // ── POST /admin/mode ───────────────────────────────────────────────────────

  private async _handleSetMode(body: string, res: http.ServerResponse): Promise<void> {
    const { mode } = JSON.parse(body) as { mode: MintMode };
    if (!(mode in MINT_MODE_INDEX)) {
      res.writeHead(400).end(JSON.stringify({ error: `unknown mode: ${String(mode)}` }));
      return;
    }
    const fn = this.contract['setMode'] as (m: number) => Promise<ethers.ContractTransactionResponse>;
    await (await fn(MINT_MODE_INDEX[mode])).wait();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ mode }));
  }

  // ── GET /admin/mode ────────────────────────────────────────────────────────

  private async _handleGetMode(res: http.ServerResponse): Promise<void> {
    const fn      = this.contract['mode'] as () => Promise<bigint>;
    const modeNum = Number(await fn());
    const mode    = MODE_REVERSE[modeNum] ?? String(modeNum);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ mode }));
  }

  // ── 유틸 ──────────────────────────────────────────────────────────────────

  private _readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: string) => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }
}
