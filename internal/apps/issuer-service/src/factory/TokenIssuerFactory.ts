import type { Pool }                    from 'pg';
import type { IBlockchainAdapter }     from '@kyobo/chain-adapters';
import type { IVASPAdapter }           from '@kyobo/vasp';
import type { ICoreBankingAdapter }    from '@kyobo/core-banking';
import { IssuerService }            from '../services/IssuerService';
import {
  IssuancePolicyService,
  PgIssuancePolicyRepository,
}                                   from '../services/IssuancePolicyService';
import { PgIssuanceRequestRepository } from '../services/IssuanceRequestRepository';
import { EventConditionService }    from '../services/EventConditionService';
import { TxStateMachineService }    from '../../../../packages/vasp/src/tx/TxStateMachineService';
import { PgTxRepository }           from '../infra/PgTxRepository';
import { VaspTxClientAdapter }      from '../../../../packages/vasp/src/tx/VaspTxClientAdapter';
import { LedgerService }            from '../../../../packages/core-banking/src/ledger/LedgerService';
import { PgDatabaseClient }         from '../infra/PgDatabaseClient';
import { TxTransitionBridge }       from '../services/TxTransitionBridge';
import { IssuanceConfirmHandler }   from '../handlers/IssuanceConfirmHandler';

/**
 * TokenIssuerFactory — 토큰 유형별 IssuerService 생성 팩토리
 *
 * 역할:
 *   Phase 1 NFT / Phase 2 KRW스테이블코인 / Phase 3 STO 발행 서비스 인스턴스를
 *   동일한 인프라 의존성 주입 구조로 생성한다.
 *
 * 의존성 주입 패턴:
 *   - chainAdapter:   EVMAdapter (또는 XRPLAdapter — 멀티체인 대응)
 *   - vaspAdapter:    ExternalVASPAdapter (Phase 1/2) → KyoboVASPAdapter (Phase 4)
 *   - coreBanking:    KyoboCoreBankingAdapter
 *   - idempotency:    IdempotencyGuard (Redis 기반 — 멱등성)
 *   - pool:           pg.Pool (issuance_policies 테이블 조회용)
 *
 * createNFTIssuer() 내부 DI:
 *   pool → PgIssuancePolicyRepository → IssuancePolicyService
 *   conditionService (호출자가 Strategy 등록 후 주입)
 *
 * Phase 3 확장:
 *   createSTOIssuer() 추가 시 STOIssuerService(extends IssuerService) 반환
 *   IssuerService 인터페이스 변경 없이 확장 가능.
 *
 */
export class TokenIssuerFactory {
  constructor(
    private readonly deps: {
      chainAdapter: IBlockchainAdapter;
      vaspAdapter:  IVASPAdapter;
      coreBanking:  ICoreBankingAdapter;
      pool:         Pool;
    },
  ) {}

  /**
   * Phase 1 — 활동 보상 NFT 발행 서비스
   *
   * @param nftIssuerAddr   배포된 NFTIssuer 컨트랙트 주소
   * @param conditionService 전략이 등록된 EventConditionService 인스턴스
   */
  createNFTIssuer(nftIssuerAddr: string, conditionService: EventConditionService): {
    issuerService:       IssuerService;
    confirmHandler:      IssuanceConfirmHandler;
    txStateMachine:      TxStateMachineService;
    txRepo:              PgTxRepository;
    ledgerService:       LedgerService;
  } {
    const policyRepo     = new PgIssuancePolicyRepository(this.deps.pool);
    const policyService  = new IssuancePolicyService(policyRepo);
    const issuanceRepo   = new PgIssuanceRequestRepository(this.deps.pool);

    // TxStatus 추적 (tx_mint_requests)
    const txRepo         = new PgTxRepository(this.deps.pool);
    const vaspTxClient   = new VaspTxClientAdapter(this.deps.vaspAdapter, nftIssuerAddr);
    const txStateMachine = new TxStateMachineService(txRepo, vaspTxClient);

    // MintStatus 추적 (mint_requests) — LedgerService
    const dbClient       = new PgDatabaseClient(this.deps.pool);
    const ledgerService  = new LedgerService(dbClient, this.deps.coreBanking);

    // TxTransitionBridge: TxStatus 전이 → MintStatus·IssuanceStatus 동기화
    const bridge         = new TxTransitionBridge(ledgerService, issuanceRepo, this.deps.coreBanking);
    bridge.attach(txStateMachine);

    // IssuanceConfirmHandler: 온체인 이벤트 → TxStateMachineService 경유 전이
    const confirmHandler = new IssuanceConfirmHandler(nftIssuerAddr, txRepo, txStateMachine);

    const issuerService  = new IssuerService({
      chainAdapter:  this.deps.chainAdapter,
      coreBanking:   this.deps.coreBanking,
      nftIssuerAddr,
      policyService,
      conditionService,
      issuanceRepo,
      txStateMachine,
      ledgerService,
    });

    return { issuerService, confirmHandler, txStateMachine, txRepo, ledgerService };
  }

  /**
   * Phase 2 — KRW 스테이블코인 발행 서비스 (MINTER_ROLE 보유 주소 필요)
   *
   * TODO Phase 2 구현 시:
   *   StablecoinIssuerService(extends IssuerService) 반환
   *   - mint(to, amount, depositTxRef)
   *   - burn(from, amount, withdrawTxRef)
   *   - ReconcileService.onMint/onBurn 호출
   */
  createStablecoinIssuer(_stablecoinAddr: string): IssuerService {
    throw new Error('TokenIssuerFactory.createStablecoinIssuer: Phase 2 미구현');
  }

  /**
   * Phase 3 — STO 보안 토큰 발행 서비스
   *
   * TODO Phase 3 구현 시:
   *   STOIssuerService(extends IssuerService) 반환
   *   - issueByPartition(partition, holder, amount, data)
   *   - InvestorRegistryService.canAccept() 선행 검증
   *   - KDEPAdapter.notifyIssuance() 후행 통보
   *   - LockupPolicyService에서 락업 기간 조회 → setLockup()
   */
  createSTOIssuer(_securityTokenAddr: string): IssuerService {
    throw new Error('TokenIssuerFactory.createSTOIssuer: Phase 3 미구현');
  }
}
