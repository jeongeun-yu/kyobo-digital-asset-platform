/**
 * ChainAdapterFactory — Factory Pattern
 *
 * M3 S14 연계: 체인 타입에 따라 적절한 어댑터 인스턴스를 생성.
 * 상위 레이어(IssuerService)는 ChainAdapterFactory.create() 한 줄로
 * 체인 교체 완료 — switch/if 분기 코드 상위 레이어에 없음.
 *
 * 사용 패턴:
 *   const adapter = ChainAdapterFactory.create({ chainType: 'EVM', ... });
 *   // 또는 환경변수 기반 자동 생성
 *   const adapter = ChainAdapterFactory.createFromEnv('EVM');
 */

import type { IBlockchainAdapter } from './interfaces/IBlockchainAdapter';
import { EVMAdapter }    from './evm/EVMAdapter';
import { XRPLAdapter }   from './xrpl/XRPLAdapter';
import { CircleAdapter } from './circle/CircleAdapter';
import { UTXOAdapter }   from './utxo/UTXOAdapter';

export type ChainType = 'EVM' | 'XRPL' | 'CIRCLE' | 'UTXO';

export interface AdapterConfig {
  chainType:   ChainType;
  rpcUrl:      string;
  chainId:     string;
  privateKey?: string;
}

export class ChainAdapterFactory {
  /**
   * 명시적 설정으로 어댑터 생성
   * 테스트·멀티체인 시나리오에서 사용
   */
  static create(config: AdapterConfig): IBlockchainAdapter {
    switch (config.chainType) {
      case 'EVM':
        return new EVMAdapter({
          rpcUrl:     config.rpcUrl,
          chainId:    config.chainId,
          privateKey: config.privateKey,
        });
      case 'XRPL':
        return new XRPLAdapter();
      case 'CIRCLE':
        return new CircleAdapter();
      case 'UTXO':
        return new UTXOAdapter();
      default: {
        const _exhaustive: never = config.chainType;
        throw new UnsupportedChainError(_exhaustive);
      }
    }
  }

  /**
   * 환경변수 기반 자동 생성
   * 프로덕션 부트스트랩에서 사용 (issuer-service/src/index.ts)
   */
  static createFromEnv(chainType: ChainType): IBlockchainAdapter {
    return ChainAdapterFactory.create({
      chainType,
      rpcUrl:     process.env['EVM_RPC_URL']    ?? 'http://localhost:8545',
      chainId:    process.env['EVM_CHAIN_ID']   ?? '31337',
      privateKey: process.env['EVM_SIGNER_KEY'] ?? undefined,
    });
  }
}

export class UnsupportedChainError extends Error {
  constructor(chainType: string) {
    super(`Unsupported chain type: ${chainType}`);
    this.name = 'UnsupportedChainError';
  }
}
