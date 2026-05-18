/**
 * DbWalletResolver — WalletResolver DB 구현체
 *
 * TxStateMachineService.submitMintRequest()에서 userId → 온체인 지갑 주소 변환 시 사용.
 *
 * 지갑 주소 조회 경로 옵션 (TODO: 실제 구조 확인 후 선택):
 *
 *   옵션 A — 내부 DB 직접 조회 (user_wallets 테이블)
 *     가장 빠름. 지갑 주소가 로컬 DB에 있는 경우.
 *
 *   옵션 B — KyoboCoreBankingAdapter 경유
 *     InternalGatewayClient → walletAddress 반환 패턴 이미 존재.
 *     core-banking 패키지와 의존성 생김.
 *
 *   옵션 C — WalletProvisioningService 경유
 *     issuer-service의 WalletProvisioningService.getOrProvisionWallet() 사용.
 *     지갑 미존재 시 자동 생성 로직 포함 — TxRepository 레이어에서 호출하기엔 과함.
 *
 * TODO: 옵션 결정 후 구현 방식 확정
 */

import type { WalletResolver } from './TxStateMachineService';

// TODO: 공용 DB 클라이언트 인터페이스 확정 후 import 경로 수정
interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class DbWalletResolver implements WalletResolver {
  constructor(private readonly db: DbClient) {}

  /**
   * userId → 온체인 지갑 주소 조회
   *
   * TODO: 지갑 주소 저장 테이블/컬럼명 확정
   *   - 현재 KyoboCoreBankingAdapter에서 walletAddress 조회 로직 존재
   *   - InternalGatewayClient.getUserInfo() 반환값에 walletAddress 포함
   *
   * TODO: 지갑 미존재 시 처리 방침 결정
   *   - throw WalletNotFoundError → 호출자(submitMintRequest)가 FAILED 전이
   *   - 자동 생성은 이 레이어 책임 아님 (WalletProvisioningService 역할)
   *
   * TODO: 캐시 도입 검토 — 동일 userId 반복 조회 시 Redis 캐싱
   */
  async getWalletAddr(userId: string): Promise<string> {
    // TODO: 구현 (옵션 A 예시)
    // const { rows } = await this.db.query(
    //   'SELECT wallet_address FROM user_wallets WHERE user_id = $1 AND is_active = true',
    //   [userId],
    // );
    // if (rows.length === 0) throw new WalletNotFoundError(userId);
    // return rows[0]!['wallet_address'] as string;
    throw new Error('DbWalletResolver.getWalletAddr: NOT IMPLEMENTED');
  }
}

export class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`Wallet not found for userId: ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}
