/**
 * ChainAdapterFactory 단위 테스트
 *
 * Factory Pattern — 체인 타입별 올바른 어댑터 인스턴스 생성 검증
 */

import { ChainAdapterFactory, UnsupportedChainError } from '../ChainAdapterFactory';
import { EVMAdapter }    from '../evm/EVMAdapter';
import { XRPLAdapter }   from '../xrpl/XRPLAdapter';
import { CircleAdapter } from '../circle/CircleAdapter';
import { UTXOAdapter }   from '../utxo/UTXOAdapter';

const BASE_CONFIG = {
  rpcUrl:  'http://localhost:8545',
  chainId: '31337',
};

describe('ChainAdapterFactory.create()', () => {
  it('chainType EVM → EVMAdapter 인스턴스 반환', () => {
    const adapter = ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'EVM' });
    expect(adapter).toBeInstanceOf(EVMAdapter);
  });

  it('chainType XRPL → XRPLAdapter 인스턴스 반환', () => {
    const adapter = ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'XRPL' });
    expect(adapter).toBeInstanceOf(XRPLAdapter);
  });

  it('chainType CIRCLE → CircleAdapter 인스턴스 반환', () => {
    const adapter = ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'CIRCLE' });
    expect(adapter).toBeInstanceOf(CircleAdapter);
  });

  it('chainType UTXO → UTXOAdapter 인스턴스 반환', () => {
    const adapter = ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'UTXO' });
    expect(adapter).toBeInstanceOf(UTXOAdapter);
  });

  it('지원하지 않는 chainType → UnsupportedChainError throw', () => {
    expect(() =>
      ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'COSMOS' as any }),
    ).toThrow(UnsupportedChainError);
  });

  it('UnsupportedChainError 메시지에 chainType 포함', () => {
    expect(() =>
      ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'COSMOS' as any }),
    ).toThrow('Unsupported chain type: COSMOS');
  });

  it('EVM 어댑터의 chainId가 설정값과 일치', () => {
    const adapter = ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'EVM', chainId: '137' });
    expect(adapter.chainId).toBe('137');
  });

  it('EVM 어댑터의 chainType은 "EVM"', () => {
    const adapter = ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'EVM' });
    expect(adapter.chainType).toBe('EVM');
  });

  it('XRPL 어댑터의 chainType은 "XRPL"', () => {
    const adapter = ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'XRPL' });
    expect(adapter.chainType).toBe('XRPL');
  });

  it('CIRCLE 어댑터의 chainType은 "BFT"', () => {
    const adapter = ChainAdapterFactory.create({ ...BASE_CONFIG, chainType: 'CIRCLE' });
    expect(adapter.chainType).toBe('BFT');
  });
});

describe('ChainAdapterFactory.createFromEnv()', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('환경변수 미설정 시 기본값으로 EVM 어댑터 생성', () => {
    delete process.env['EVM_RPC_URL'];
    delete process.env['EVM_CHAIN_ID'];
    const adapter = ChainAdapterFactory.createFromEnv('EVM');
    expect(adapter).toBeInstanceOf(EVMAdapter);
  });

  it('EVM_CHAIN_ID 환경변수가 반영됨', () => {
    process.env['EVM_CHAIN_ID'] = '1';
    const adapter = ChainAdapterFactory.createFromEnv('EVM');
    expect(adapter.chainId).toBe('1');
  });
});

describe('UnsupportedChainError', () => {
  it('name이 "UnsupportedChainError"', () => {
    const err = new UnsupportedChainError('FOO');
    expect(err.name).toBe('UnsupportedChainError');
  });

  it('Error 클래스를 상속', () => {
    expect(new UnsupportedChainError('FOO')).toBeInstanceOf(Error);
  });
});
