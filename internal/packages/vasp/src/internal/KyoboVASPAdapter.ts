// =============================================================================
// 향후 내재화 STUB — 교보생명 자체 VASP 운영 시 구현
// =============================================================================
// 구현 시점: 교보생명 금융위원회 VASP 신고/인가 취득 후 (일정 미확정)
//
// 내재화 시 구현 항목:
//   1. HSM (Hardware Security Module) 또는 MPC 기반 지갑 생성·서명
//      - Private key가 서버 메모리에 존재하지 않는 구조 필수
//      - 금융보안원 전자금융기반시설 보안 요건 준수
//
//   2. Travel Rule 자체 처리
//      - TRISA 또는 VerifyVASP 프로토콜 직접 구현
//      - 상대방 VASP와 암호화 채널로 수신자 정보 교환
//
//   3. AML 자체 스크리닝
//      - Chainalysis 또는 Elliptic API 직접 연동
//      - 블랙리스트 DB 자체 유지
//
//   4. 출금 한도·승인 워크플로우
//      - 대규모 출금 다중 서명 승인 (M-of-N)
//      - 이상 거래 탐지 → 자동 동결
//
// ExternalVASPAdapter와 동일한 IVASPAdapter 구현 → 상위 레이어 수정 없음.
// 교체는 DI(의존성 주입) 컨테이너의 바인딩 변경만으로 완료.
// =============================================================================

import type { IVASPAdapter, WalletInfo, TransferRequest, TransferResult, SubmitTransactionParams, VASPTransactionReceipt } from '../interfaces/IVASPAdapter';

export class KyoboVASPAdapter implements IVASPAdapter {
  async submitTransaction(_params: SubmitTransactionParams): Promise<VASPTransactionReceipt> { throw new Error('KyoboVASPAdapter: not implemented — 향후 내재화 시 구현'); }
  async createWallet(_userId: string): Promise<WalletInfo> { throw new Error('KyoboVASPAdapter: not implemented — 향후 내재화 시 구현'); }
  async getWallet(_userId: string): Promise<WalletInfo | null> { throw new Error('KyoboVASPAdapter: not implemented — 향후 내재화 시 구현'); }
  async transfer(_req: TransferRequest): Promise<TransferResult> { throw new Error('KyoboVASPAdapter: not implemented — 향후 내재화 시 구현'); }
  async getTransferStatus(_txHash: string): Promise<TransferResult> { throw new Error('KyoboVASPAdapter: not implemented — 향후 내재화 시 구현'); }
  async screenAddress(_address: string): Promise<{ flagged: boolean; reason?: string }> { throw new Error('KyoboVASPAdapter: not implemented — 향후 내재화 시 구현'); }
}
