/**
 * ChainAdapterRegistry — 멀티체인 동시 운영 레지스트리
 *
 * Phase 1: 사용하지 않음 (단일 체인 EVM).
 * Phase 2+: EVM + XRPL 동시 운영 시 chainId 기반 라우팅에 사용.
 *
 * 사용 패턴 (Phase 2):
 *   const registry = new ChainAdapterRegistry();
 *   registry.register(ChainAdapterFactory.create({ chainType: 'EVM', ... }));
 *   registry.register(ChainAdapterFactory.create({ chainType: 'XRPL', ... }));
 *
 *   // 정책 DB의 chain_id로 어댑터 선택
 *   const adapter = registry.get(policy.chainId);
 *   await adapter.mintNFT(params);
 */

import type { IBlockchainAdapter } from './interfaces/IBlockchainAdapter';
import { UnsupportedChainError }   from './ChainAdapterFactory';

export class ChainAdapterRegistry {
  private readonly adapters = new Map<string, IBlockchainAdapter>();

  /** 어댑터 등록. chainId가 중복되면 덮어씀. */
  register(adapter: IBlockchainAdapter): void {
    this.adapters.set(adapter.chainId, adapter);
  }

  /** chainId로 어댑터 조회. 미등록 시 UnsupportedChainError. */
  get(chainId: string): IBlockchainAdapter {
    const adapter = this.adapters.get(chainId);
    if (!adapter) throw new UnsupportedChainError(chainId);
    return adapter;
  }

  /** 등록된 모든 어댑터 반환. 멀티체인 브로드캐스트·헬스체크에 사용. */
  getAll(): IBlockchainAdapter[] {
    return [...this.adapters.values()];
  }

  /** 등록 여부 확인. */
  has(chainId: string): boolean {
    return this.adapters.has(chainId);
  }

  /** 등록된 chainId 목록 반환. */
  chainIds(): string[] {
    return [...this.adapters.keys()];
  }
}
