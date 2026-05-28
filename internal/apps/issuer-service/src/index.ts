/**
 * issuer-service — Phase 1 NFT 발행 서비스 메인 진입점
 *
 * 이 서비스가 하는 일:
 *   1. 교보 앱 서버로부터 Webhook 수신 (활동 달성 이벤트)
 *   2. KYC 상태 확인 (IKYCProvider)
 *   3. AML 스크리닝 (IVASPAdapter.screenAddress)
 *   4. 스마트컨트랙트 NFT 발행 (NFTIssuer.issueActivityNFT)
 *   5. Core Banking 알림 (ICoreBankingAdapter.notifyReward)
 *   6. 온체인 이벤트 구독 → 발행 완료 확인
 *
 * 각 레이어는 인터페이스를 통해 주입 — Phase 2/3에서 구현체만 교체.
 */

import http                         from 'http';
import Redis                        from 'ioredis';
import { Pool }                    from 'pg';
import { EVMAdapter }              from '@kyobo/chain-adapters';
import { ChainEventListener }      from '@kyobo/event-engine/listener';
import { WebhookServer, WebhookPublishHandler } from '@kyobo/event-engine/webhook';
import { IdempotencyGuard, RedisIdempotencyStore } from '@kyobo/event-engine/webhook';
import {
  ConsumerGroupPool,
  DLQHandler,
  NFTIssuedProcessor,
  ActivityProcessor,
  RedisStreamPublisher,
}                                  from '@kyobo/event-engine';
import { PgNFTLedgerService }      from './infra/PgNFTLedgerService';
import { IoRedisAdapter }          from './infra/RedisAdapter';
import { ExternalVASPAdapter, KyoboVASPAdapter } from '@kyobo/vasp';
// Phase 3 전환 시: ExternalVASPAdapter → KyoboVASPAdapter 로 교체
// KyoboVASPAdapter는 @kyobo/vasp 패키지에 stub 구현 완료 (IVASPAdapter 동일 인터페이스)
import { KyoboCoreBankingAdapter, InternalGatewayClient, ReconcileService, ReconcileAdminService } from '@kyobo/core-banking';

import { TokenIssuerFactory }      from './factory/TokenIssuerFactory';
import { ActivityConditionStrategy, EventConditionService } from './services/EventConditionService';
import { ActivityRouter }          from './api/ActivityRouter';
import { IssuanceConfirmHandler }  from './handlers/IssuanceConfirmHandler';
import { ProcessedEventHandler }   from './handlers/ProcessedEventHandler';
import { PgIssuanceRequestRepository } from './services/IssuanceRequestRepository';
import { PgNftHoldingRepository }  from './infra/PgNftHoldingRepository';
import { PgDatabaseClient }        from './infra/PgDatabaseClient';
import NFTIssuerABI                from './abi/NFTIssuer.json';

async function bootstrap() {
  // ── 환경 변수 검증 ──────────────────────────────────────────────────────────
  const required = [
    'RPC_URL', 'CHAIN_ID', 'OPERATOR_PRIVATE_KEY',
    'NFT_CONTRACT_ADDR', 'NFT_ISSUER_ADDR',
    'VASP_API_URL', 'VASP_API_KEY',
    'CORE_BANKING_URL', 'CORE_BANKING_SECRET',
    'WEBHOOK_SECRET', 'WEBHOOK_PORT',
    'REDIS_URL',
    'DATABASE_URL',
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env: ${key}`);
  }

  // ── 체인 어댑터 ──────────────────────────────────────────────────────────────
  // Phase 1: EVMAdapter (read-only — ChainEventListener 폴백 폴링 + FINALIZED 확인)
  //          TX 실행은 ExternalVASPAdapter 위탁 / ChainEventListener는 Phase 1부터 가동
  //          → VASP 장애·내부 서버 누락 시 RPC 직접 폴링으로 온체인 이벤트 복구
  // Phase 2: EVMAdapter 유지 + Circle Arc USDC/KRW1 결제 레이어 추가
  // Phase 3: EVMAdapter.sendTransaction() 활성화 (KyoboVASPAdapter 전환 시 직접 호출)
  const chainAdapter = new EVMAdapter({
    rpcUrl:     process.env.RPC_URL!,
    chainId:    process.env.CHAIN_ID!,
    privateKey: process.env.OPERATOR_PRIVATE_KEY!,
  });

  // ── VASP 어댑터 ──────────────────────────────────────────────────────────────
  // Phase 1: ExternalVASPAdapter (월렛원 외부 API 위탁 — TX 서명·브로드캐스트 전위임)
  //          온체인 상태 수신 경로 2개:
  //            ① VASP → NFT_ISSUED 인바운드 웹훅 → Redis Streams → LedgerService
  //            ② ChainEventListener RPC 직접 폴링 → NFTIssuedHandler + IssuanceConfirmHandler
  //          ①이 정상 경로, ②는 VASP 장애·웹훅 누락 시 복구용 폴백 (Phase 1 공존)
  // Phase 2: ExternalVASPAdapter 유지 + Circle Arc USDC/KRW1 결제 레이어 추가
  // Phase 3: KyoboVASPAdapter   (교보 VASP 인가 취득 후 HSM/MPC 직접 서명·브로드캐스트)
  //          → new KyoboVASPAdapter() 로 교체, 상위 레이어 수정 없음
  const vaspAdapter = new ExternalVASPAdapter({
    baseUrl: process.env.VASP_API_URL!,
    apiKey:  process.env.VASP_API_KEY!,
  });

  // ── Core Banking ─────────────────────────────────────────────────────────────
  const gatewayClient = new InternalGatewayClient({
    baseUrl: process.env.CORE_BANKING_URL!,
    secret:  process.env.CORE_BANKING_SECRET!,
  });
  const coreBanking = new KyoboCoreBankingAdapter(gatewayClient);

  // ── PostgreSQL ────────────────────────────────────────────────────────────────
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL! });

  // ── Redis ────────────────────────────────────────────────────────────────────
  const redis        = new Redis(process.env.REDIS_URL!);
  const redisAdapter = new IoRedisAdapter(redis);

  // ── 멱등성 가드 ──────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idempotency = new IdempotencyGuard(new RedisIdempotencyStore(redis as any));

  // ── 조건 서비스 (Strategy 등록) ───────────────────────────────────────────────
  const conditionService = new EventConditionService([
    new ActivityConditionStrategy(),
    // Phase 2+: new CouponConditionStrategy(eligibilityChecker)
    // Phase 2+: new PremiumConditionStrategy(threshold)
  ]);

  // ── 발행 서비스 (Factory 경유 — policyService·issuanceRepo 자동 주입) ─────────
  const factory       = new TokenIssuerFactory({ chainAdapter, vaspAdapter, coreBanking, pool: pgPool });
  const {
    issuerService,
    confirmHandler: issuanceConfirmHandler,
    txStateMachine,
    txRepo,
    ledgerService,
  } = factory.createNFTIssuer(process.env.NFT_ISSUER_ADDR!, conditionService);

  // ── 온체인 이벤트 리스너 ──────────────────────────────────────────────────────
  const eventListener = new ChainEventListener(
    chainAdapter,
    [issuanceConfirmHandler, new ProcessedEventHandler(process.env.NFT_CONTRACT_ADDR!, ledgerService)],
    [{
      addr:       process.env.NFT_CONTRACT_ADDR!,
      abi:        NFTIssuerABI,
      eventNames: ['Issued'],
    }],
    {
      // Phase 2+: Redis/DB 기반 스테이트 스토어로 교체 (재시작 내성)
      // CHAIN_START_BLOCK: 공개 RPC(Alchemy 등) 사용 시 현재 블록을 주입해 과거 전체 조회 방지
      async getLastProcessedBlock() { return Number(process.env.CHAIN_START_BLOCK ?? 0); },
      async setLastProcessedBlock(_b: number) {},
    },
  );

  // ── Redis Streams 발행 클라이언트 ────────────────────────────────────────────
  const streamPublisher  = new RedisStreamPublisher(redisAdapter);
  const webhookPublisher = new WebhookPublishHandler(streamPublisher, idempotency);

  // ── Webhook 서버 ──────────────────────────────────────────────────────────────
  // 모든 인바운드 Webhook → WebhookPublishHandler → Redis Streams 적재 (단일 경로)
  //
  // 내부 인바운드 (교보 앱 서버):
  //   ACTIVITY_ACHIEVED / COUPON_CLAIM → webhookPublisher → activity-consumers
  // 외부 VASP 콜백:
  //   NFT_ISSUED / VASP_TX_FAILED → webhookPublisher → nft-consumers / vasp-consumers
  //
  // VASP_TX_FAILED는 ActivityRouter 직접 경로를 유지 (nonce 재사용 방지 목적)
  const webhookServer = new WebhookServer({
    port:      Number(process.env.WEBHOOK_PORT),
    secret:    process.env.WEBHOOK_SECRET!,
    maxBodyKb: 64,
  });

  webhookServer
    // 내부 인바운드 → Redis Stream
    .on('ACTIVITY_ACHIEVED', webhookPublisher.createHandler())
    .on('COUPON_CLAIM',      webhookPublisher.createHandler())
    // VASP 콜백 → Redis Stream
    .on('NFT_ISSUED', webhookPublisher.createHandler())
    // VASP_TX_FAILED: 직접 처리 (실패 TX → issuance_requests FAILED 즉시 전이)
    // 지연 없이 DB 상태를 갱신해야 하므로 Redis Stream 우회
    .on('VASP_TX_FAILED', async (payload) => {
      const data = payload.data as { txHash: string; reason?: string };
      await issuerService.handleVaspTxFailed({ txHash: data.txHash, reason: data.reason });
    });

  // ── Redis Streams Consumer (NFT_ISSUED) ──────────────────────────────────────
  const streamDlq = new DLQHandler(
    redisAdapter,
    { async sendAlert(msg) { console.error('[DLQ]', msg); } },
  );
  const ledger = new PgNFTLedgerService(pgPool, process.env.NFT_CONTRACT_ADDR!, Number(process.env.CHAIN_ID ?? '11155111'), coreBanking, txStateMachine, txRepo);

  const nftIssuedProcessor  = new NFTIssuedProcessor(idempotency, ledger);
  const activityProcessor   = new ActivityProcessor(issuerService, idempotency);

  // 도메인별 Consumer Group 분리 — 각 그룹이 스트림을 독립적으로 소비
  // 이벤트 타입이 일치하지 않는 메시지는 ConsumerGroupWorker가 즉시 XACK 처리
  const pool = new ConsumerGroupPool(
    redisAdapter,
    streamDlq,
    { streamKey: 'kyobo:events', batchSize: 10, blockMs: 5_000, minIdleMs: 30_000 },
    [
      { groupName: 'nft-consumers',      consumerId: 'nft-1',      processors: [nftIssuedProcessor] },
      { groupName: 'activity-consumers', consumerId: 'activity-1', processors: [activityProcessor] },
    ],
  );

  // ── Reconcile ────────────────────────────────────────────────────────────────
  const pgHoldingRepo   = new PgNftHoldingRepository(pgPool);
  const reconcileService = new ReconcileService(
    coreBanking,
    {
      getTotalSupply:          async () => 0n,  // Phase 2: KRW 스테이블코인 컨트랙트 연동
      getCustodyAccountBalance: async () => 0n,
      balanceOf: (addr, tokenId) =>
        chainAdapter.getBalance(process.env.NFT_CONTRACT_ADDR!, addr, tokenId),
      getNftHoldings: (addr) =>
        chainAdapter.getNftHoldings(
          process.env.NFT_CONTRACT_ADDR!, addr, Number(process.env.CHAIN_START_BLOCK ?? 0),
        ),
      getBlockNumber: () => chainAdapter.getBlockNumber(),
    },
    pgHoldingRepo,
    { fire: async (msg, sev) => console.warn('[Reconcile]', sev, msg) },
  );
  const reconcileAdmin = new ReconcileAdminService(
    new PgDatabaseClient(pgPool),
    reconcileService,
    coreBanking,
    { sendAlert: async (p) => console.warn('[ReconcileAlert]', p.severity, p.title) },
  );

  // ── Admin HTTP (데모/테스트 전용 — ADMIN_PORT 설정 시에만 활성화) ───────────────
  // pollStaleRequests / reconcile 수동 트리거 용도. 운영에서는 ADMIN_PORT 미설정.
  const adminPort = Number(process.env.ADMIN_PORT ?? 0);
  if (adminPort > 0) {
    http.createServer(async (req, res) => {
      try {
        if (req.method === 'POST' && req.url === '/admin/poll-stale') {
          const result = await txStateMachine.pollStaleRequests();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));

        } else if (req.method === 'POST' && req.url === '/admin/reconcile/run') {
          const body = await new Promise<string>((ok, ng) => {
            let buf = '';
            req.on('data', c => { buf += c; });
            req.on('end',  () => ok(buf));
            req.on('error', ng);
          });
          const { userId, operator = 'admin' } = JSON.parse(body) as { userId: string; operator?: string };
          const result = await reconcileAdmin.runManualReconcile(userId, operator);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result, (_k, v) => typeof v === 'bigint' ? v.toString() : v));

        } else if (req.method === 'GET' && req.url?.startsWith('/admin/reconcile/history')) {
          const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') ?? '20');
          const rows  = await reconcileAdmin.getHistory(limit);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rows));

        } else if (req.method === 'POST' && req.url === '/admin/credit-nft') {
          // 임시 — 데모/테스트 전용: 특정 userId에 NFT +amount 직접 기록
          const body = await new Promise<string>((ok, ng) => {
            let buf = '';
            req.on('data', c => { buf += c; });
            req.on('end',  () => ok(buf));
            req.on('error', ng);
          });
          const { userId, tokenId, amount = 1, txHash: onChainTx = '', operator = 'admin' } =
            JSON.parse(body) as { userId: string; tokenId: string; amount?: number; txHash?: string; operator?: string };
          await reconcileAdmin.creditNft({
            userId,
            tokenId:      BigInt(tokenId),
            contractAddr: process.env.NFT_CONTRACT_ADDR!,
            chainId:      Number(process.env.CHAIN_ID!),
            amount:       BigInt(amount),
            onChainTx,
            operator,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, userId, tokenId, amount }));

        } else {
          res.writeHead(404).end('{}');
        }
      } catch (e) {
        res.writeHead(500).end(JSON.stringify({ error: String(e) }));
      }
    }).listen(adminPort, () =>
      console.log(`[admin] :${adminPort} /admin/poll-stale | /admin/reconcile/run | /admin/reconcile/history | /admin/credit-nft`),
    );
  }

  // ── 시작 ─────────────────────────────────────────────────────────────────────
  await eventListener.start();
  await webhookServer.listen();
  pool.start().catch(err => {
    console.error('[pool] fatal error, exiting', err);
    process.exit(1);
  });

  console.log('[issuer-service] started');

  // ── 종료 핸들링 ──────────────────────────────────────────────────────────────
  const shutdown = async () => {
    pool.stop();
    await eventListener.stop();
    await webhookServer.close();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch(err => {
  console.error('[issuer-service] fatal:', err);
  process.exit(1);
});
