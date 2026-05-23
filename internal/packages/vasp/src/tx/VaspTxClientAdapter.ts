/**
 * VaspTxClientAdapter — IVASPAdapter → VaspTxClient 브리지
 *
 * IssuerService가 사용하는 IVASPAdapter(비즈니스 추상화)를
 * TxStateMachineService가 요구하는 VaspTxClient(TX 실행 추상화)로 변환한다.
 *
 * Phase 3 전환 시: 이 어댑터를 제거하고 VaspTxClient 직접 구현체(NonceManager + Broadcaster)로 교체.
 */

import type { IVASPAdapter }              from '../interfaces/IVASPAdapter';
import type { VaspTxClient }              from './TxStateMachineService';
import NFT_ISSUER_ABI                     from '../../../../apps/issuer-service/src/abi/NFTIssuer.json';

export class VaspTxClientAdapter implements VaspTxClient {
  constructor(
    private readonly vasp:           IVASPAdapter,
    private readonly nftIssuerAddr:  string,
  ) {}

  async submitMint(params: {
    to:        string;
    tokenId:   bigint;
    amount:    bigint;
    requestId: string;
  }): Promise<{ txHash: string }> {
    const receipt = await this.vasp.submitTransaction({
      contractAddr:   this.nftIssuerAddr,
      abi:            NFT_ISSUER_ABI,
      method:         'mint',
      args: [
        params.to,
        params.tokenId.toString(),
        params.amount.toString(),
        `0x${Buffer.from(params.requestId).toString('hex').padEnd(64, '0')}`,
      ],
      idempotencyKey: params.requestId,
    });

    if (receipt.status === 'failed') {
      throw new Error(`VASP TX failed: ${receipt.txHash}`);
    }

    return { txHash: receipt.txHash };
  }

  async getStatus(txHash: string): Promise<{
    status:        'pending' | 'mined' | 'confirmed' | 'failed' | 'not_found';
    blockNumber?:  number;
    revertReason?: string;
  }> {
    try {
      const result = await this.vasp.getTransferStatus(txHash);
      const status = result.status === 'completed' ? 'confirmed'
                   : result.status === 'pending'   ? 'pending'
                   :                                  'failed';
      return { status };
    } catch {
      return { status: 'not_found' };
    }
  }

  async resubmitWithGasBump(
    _txHash:          string,
    _gasBumpPercent:  number,
  ): Promise<{ txHash: string }> {
    // Phase 1: 월렛원 REST API에서 gas bump 재전송 미지원 — Phase 3에서 구현
    throw new Error('VaspTxClientAdapter.resubmitWithGasBump: Phase 3에서 구현 예정');
  }
}
