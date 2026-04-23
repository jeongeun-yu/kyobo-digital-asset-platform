import type { IChainAdapter }  from '@kyobo/chain-adapters';
import type { IVASPAdapter }   from '@kyobo/vasp';
import type { ICoreBankingAdapter } from '@kyobo/core-banking';
import type { IdempotencyGuard }    from '@kyobo/event-engine/webhook';
import { IssuerService }            from '../services/IssuerService';

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
 *
 * Phase 3 확장:
 *   createSTOIssuer() 추가 시 STOIssuerService(extends IssuerService) 반환
 *   IssuerService 인터페이스 변경 없이 확장 가능.
 */
export class TokenIssuerFactory {
  constructor(
    private readonly deps: {
      chainAdapter: IChainAdapter;
      vaspAdapter:  IVASPAdapter;
      coreBanking:  ICoreBankingAdapter;
      idempotency:  IdempotencyGuard;
    },
  ) {}

  /**
   * Phase 1 — 활동 보상 NFT 발행 서비스
   */
  createNFTIssuer(nftIssuerAddr: string): IssuerService {
    return new IssuerService({
      ...this.deps,
      nftIssuerAddr,
    });
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
