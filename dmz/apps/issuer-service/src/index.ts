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

import { EVMAdapter }              from '@kyobo/chain-adapters';
import { ChainEventListener }      from '@kyobo/event-engine/listener';
import { WebhookServer }           from '@kyobo/event-engine/webhook';
import { IdempotencyGuard, InMemoryIdempotencyStore } from '@kyobo/event-engine/webhook';
import { RetryHandler, DeadLetterQueue } from '@kyobo/event-engine/webhook';
import { NFTIssuedHandler }        from '@kyobo/event-engine/handlers';
import { ExternalVASPAdapter }     from '@kyobo/vasp';
import { KyoboCoreBankingAdapter, InternalGatewayClient } from '@kyobo/core-banking';
import { ISMSChecklist }           from '@kyobo/compliance';

import { IssuerService }   from './services/IssuerService';
import { ActivityRouter }  from './api/ActivityRouter';

async function bootstrap() {
  // ── 환경 변수 검증 ──────────────────────────────────────────────────────────
  const required = [
    'RPC_URL', 'CHAIN_ID', 'OPERATOR_PRIVATE_KEY',
    'NFT_CONTRACT_ADDR', 'NFT_ISSUER_ADDR',
    'VASP_API_URL', 'VASP_API_KEY',
    'CORE_BANKING_URL', 'CORE_BANKING_SECRET',
    'WEBHOOK_SECRET', 'WEBHOOK_PORT',
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env: ${key}`);
  }

  // ── 체인 어댑터 (Phase 2+: XRPLAdapter로 교체 가능) ─────────────────────────
  const chainAdapter = new EVMAdapter({
    rpcUrl:     process.env.RPC_URL!,
    chainId:    process.env.CHAIN_ID!,
    privateKey: process.env.OPERATOR_PRIVATE_KEY!,
  });

  // ── VASP 어댑터 (Phase 4: KyoboVASPAdapter로 교체) ──────────────────────────
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

  // ── 멱등성 가드 (프로덕션: RedisIdempotencyStore로 교체) ─────────────────────
  const idempotency = new IdempotencyGuard(new InMemoryIdempotencyStore());

  // ── Retry + DLQ ──────────────────────────────────────────────────────────────
  const dlq   = new DeadLetterQueue();
  const retry = new RetryHandler(
    { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30000, backoffFactor: 2 },
    dlq,
  );

  // ── 발행 서비스 ───────────────────────────────────────────────────────────────
  const issuerService = new IssuerService({
    chainAdapter,
    vaspAdapter,
    coreBanking,
    idempotency,
    nftIssuerAddr: process.env.NFT_ISSUER_ADDR!,
  });

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
      abi:        [], // TODO: KyoboNFT ABI import
      eventNames: ['Issued', 'Revoked'],
    }],
    {
      // TODO: DB 기반 스테이트 스토어로 교체
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
  const isms = new ISMSChecklist();
  setInterval(async () => {
    const results = await isms.runAll();
    const summary = isms.getSummary(results);
    if (summary.failed.length > 0) {
      console.error('[ISMS] 점검 실패 항목:', summary.failed);
    }
  }, 60 * 60 * 1000);  // 1시간마다

  // ── 시작 ─────────────────────────────────────────────────────────────────────
  await eventListener.start();
  await webhookServer.listen();

  console.log('[issuer-service] started');

  // ── 종료 핸들링 ──────────────────────────────────────────────────────────────
  const shutdown = async () => {
    await eventListener.stop();
    await webhookServer.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch(err => {
  console.error('[issuer-service] fatal:', err);
  process.exit(1);
});
