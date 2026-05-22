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

import Redis                        from 'ioredis';
import { Pool }                    from 'pg';
import { EVMAdapter }              from '@kyobo/chain-adapters';
import { ChainEventListener }      from '@kyobo/event-engine/listener';
import { WebhookServer }           from '@kyobo/event-engine/webhook';
import { IdempotencyGuard, InMemoryIdempotencyStore } from '@kyobo/event-engine/webhook';
import { RetryHandler, DeadLetterQueue } from '@kyobo/event-engine/webhook';
import { NFTIssuedHandler }        from '@kyobo/event-engine/handlers';
import {
  ConsumerGroupPool,
  DLQHandler,
  NFTIssuedProcessor,
  InMemoryLedgerService,
}                                  from '@kyobo/event-engine';
import { IoRedisAdapter }          from './infra/RedisAdapter';
import { ExternalVASPAdapter, KyoboVASPAdapter } from '@kyobo/vasp';
// Phase 3 전환 시: ExternalVASPAdapter → KyoboVASPAdapter 로 교체
// KyoboVASPAdapter는 @kyobo/vasp 패키지에 stub 구현 완료 (IVASPAdapter 동일 인터페이스)
import { KyoboCoreBankingAdapter, InternalGatewayClient } from '@kyobo/core-banking';
import { ISMSChecklist }           from '@kyobo/compliance';

import { TokenIssuerFactory }      from './factory/TokenIssuerFactory';
import { ActivityConditionStrategy, EventConditionService } from './services/EventConditionService';
import { ActivityRouter }          from './api/ActivityRouter';
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
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env: ${key}`);
  }

  // ── 체인 어댑터 ──────────────────────────────────────────────────────────────
  // Phase 1: EVMAdapter (read-only — FINALIZED 확인 전용, TX 실행은 VASP 위탁)
  // Phase 2: EVMAdapter 유지 + ChainEventListener 직접 이벤트 구독 활성화
  // Phase 3: EVMAdapter.sendTransaction() 활성화 (KyoboVASPAdapter 전환 시 직접 호출)
  const chainAdapter = new EVMAdapter({
    rpcUrl:     process.env.RPC_URL!,
    chainId:    process.env.CHAIN_ID!,
    privateKey: process.env.OPERATOR_PRIVATE_KEY!,
  });

  // ── VASP 어댑터 ──────────────────────────────────────────────────────────────
  // Phase 1: ExternalVASPAdapter (월렛원 외부 API 위탁 — TX 서명·브로드캐스트 전위임)
  // Phase 2: ExternalVASPAdapter 유지 + Circle Arc USDC/KRW1 결제 레이어 추가
  //          ChainEventListener 직접 이벤트 구독 시작 (월렛원 Webhook 의존도 감소)
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

  // ── 멱등성 가드 (프로덕션: RedisIdempotencyStore로 교체) ─────────────────────
  const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());

  // ── Retry + DLQ ──────────────────────────────────────────────────────────────
  const dlq   = new DeadLetterQueue();
  const retry = new RetryHandler(
    { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30000, backoffFactor: 2 },
    dlq,
  );

  // ── 조건 서비스 (Strategy 등록) ───────────────────────────────────────────────
  const conditionService = new EventConditionService([
    new ActivityConditionStrategy(),
    // Phase 2+: new CouponConditionStrategy(eligibilityChecker)
    // Phase 2+: new PremiumConditionStrategy(threshold)
  ]);

  // ── 발행 서비스 (Factory 경유 — policyService·issuanceRepo 자동 주입) ─────────
  const factory       = new TokenIssuerFactory({ chainAdapter, vaspAdapter, coreBanking, idempotency, pool: pgPool });
  const issuerService = factory.createNFTIssuer(process.env.NFT_ISSUER_ADDR!, conditionService);

  // ── 온체인 이벤트 리스너 ──────────────────────────────────────────────────────
  const nftIssuedHandler = new NFTIssuedHandler(
    process.env.NFT_CONTRACT_ADDR!,
    idempotency,
    retry,
    {
      coreBankingWebhookUrl: `${process.env.CORE_BANKING_URL}/webhooks/nft`,
      webhookSecret:          process.env.CORE_BANKING_SECRET!,
    },
  );

  const eventListener = new ChainEventListener(
    chainAdapter,
    [nftIssuedHandler],
    [{
      addr:       process.env.NFT_CONTRACT_ADDR!,
      abi:        NFTIssuerABI,
      eventNames: ['Issued'],
    }],
    {
      // Phase 2: Redis/DB 기반 스테이트 스토어로 교체 (재시작 내성)
      async getLastProcessedBlock() { return 0; },
      async setLastProcessedBlock(_b: number) {},
    },
  );

  // ── Webhook 서버 (교보 앱 서버 → 활동 달성 이벤트 수신) ────────────────────
  const webhookServer = new WebhookServer({
    port:      Number(process.env.WEBHOOK_PORT),
    secret:    process.env.WEBHOOK_SECRET!,
    maxBodyKb: 64,
  });

  const activityRouter = new ActivityRouter(issuerService, idempotency);
  activityRouter.register(webhookServer);

  // ── ISMS 자동 점검 (주기적 실행) ─────────────────────────────────────────────
  const isms = new ISMSChecklist({
    rpcUrl:          process.env.RPC_URL!,
    nftContractAddr: process.env.NFT_CONTRACT_ADDR!,
    contractCall:    (addr, abi, method) =>
      chainAdapter.call({ contractAddr: addr, abi, method, args: [] }),
    queryLatestAuditLog: async () => null,  // Phase 2: DB 연동으로 교체
  });
  setInterval(async () => {
    const results = await isms.runAll();
    const summary = isms.getSummary(results);
    if (summary.failed.length > 0) {
      console.error('[ISMS] 점검 실패 항목:', summary.failed);
    }
  }, 60 * 60 * 1000);  // 1시간마다

  // ── Redis Streams Consumer (NFT_ISSUED) ──────────────────────────────────────
  const streamDlq = new DLQHandler(
    redisAdapter,
    { async sendAlert(msg) { console.error('[DLQ]', msg); } },
  );
  const ledger = new InMemoryLedgerService(); // M4에서 PostgreSQL 구현체로 교체

  const nftIssuedProcessor = new NFTIssuedProcessor(idempotency, ledger);

  // 도메인별 Consumer Group 분리 — 프로세서/핸들러 추가 시 여기에 항목 추가
  const pool = new ConsumerGroupPool(
    redisAdapter,
    streamDlq,
    { streamKey: 'kyobo:events', batchSize: 10, blockMs: 5_000, minIdleMs: 30_000 },
    [
      { groupName: 'nft-consumers', consumerId: 'nft-1', processors: [nftIssuedProcessor] },
      // { groupName: 'activity-consumers', consumerId: 'activity-1', processors: [activityProcessor] },
      // { groupName: 'coupon-consumers',   consumerId: 'coupon-1',   processors: [couponProcessor]   },
    ],
  );

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
