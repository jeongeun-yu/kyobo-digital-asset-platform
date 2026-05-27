/**
 * NonceManager — EVM Nonce 관리 전담 모듈 (Phase 3: 직접 Custody 전환 시 활성화)
 *
 * ─ Nonce란 무엇인가 ─
 *   EVM에서 각 주소(EOA)는 TX마다 단조 증가하는 정수를 붙인다.
 *   같은 Nonce를 가진 TX는 하나만 채굴된다.
 *   Nonce 갭이 생기면 후속 TX 전체가 블록킹된다.
 *
 *   예: Nonce 5가 처리 안 됐으면 Nonce 6,7,8도 mempool에서 대기
 *
 * ─ 3가지 Nonce 전략 ─
 *
 *   SERIAL_STRICT   (직렬 엄격)
 *     이전 TX가 확정된 후에만 다음 TX 전송.
 *     가장 안전하지만 처리량이 낮음 (TPS 1).
 *     Phase 1 현재 방식 (VASP가 대신 관리).
 *
 *   PIPELINED       (파이프라인)
 *     확정 대기 중에도 다음 Nonce 미리 할당해 전송.
 *     처리량 높음. 단, 중간 TX 실패 시 Nonce 갭 발생 위험.
 *     대용량 발행(BulkIssue) 시 사용.
 *
 *   PINNED          (고정)
 *     특정 주소를 특정 Nonce에 고정.
 *     Gnosis Safe처럼 오프체인 서명 후 나중에 전송할 때 사용.
 *
 * ─ Nonce 갭 발생 시나리오 ─
 *   Nonce 5 TX → DROPPED (mempool에서 제거)
 *   → Nonce 6,7,8 TX가 mempool에서 영구 대기
 *   → 복구: Nonce 5에 빈 TX 채우기 (0 ETH to self, high gas)
 *
 * Phase 1 현황:
 *   VASP(월렛원)가 Nonce를 직접 관리. NonceManager 불필요.
 *   TxStateMachineService.handleTimeout()의 gas bump는
 *   VASP API를 통해 간접적으로 Nonce를 재사용.
 *
 * Phase 3 필요성:
 *   교보 자체 VASP 운영 시 Nonce를 직접 할당·추적해야 함.
 *   단일 주소에서 동시 TX 발행 시 Nonce 충돌 방지 필수.
 *
 */

// ── 타입 ─────────────────────────────────────────────────────────────────────

export type NonceStrategy = 'SERIAL_STRICT' | 'PIPELINED' | 'PINNED';

export interface NonceAllocation {
  nonce:     number;
  attemptId: string;
  address:   string;
  chainId:   string;
  allocatedAt: Date;
}

// ── NonceManager ──────────────────────────────────────────────────────────────

/**
 * Phase 3: Nonce 할당, 추적, 갭 감지·복구 전담
 *
 * 핵심 제약:
 *   UNIQUE(chainId, fromAddress, nonce) — DB 레벨에서 중복 Nonce 방지
 *   단일 writer per address — 동시 Nonce 할당은 반드시 직렬화
 */
export class NonceManager {
  constructor(
    private readonly strategy: NonceStrategy,
    private readonly chainRpc: { getTransactionCount(addr: string): Promise<number> },
  ) {}

  /**
   * Phase 3: 다음 Nonce 할당
   *   1. DB lock으로 동시 할당 직렬화
   *   2. RPC getTransactionCount로 온체인 Nonce 확인
   *   3. PIPELINED: 마지막 할당 Nonce + 1
   *   4. SERIAL_STRICT: 온체인 confirmed Nonce + 1
   */
  async allocate(
    _address: string,
    _chainId: string,
    _attemptId: string,
  ): Promise<number> {
    throw new Error('Phase 3 — NonceManager.allocate 구현 필요');
  }

  /**
   * Phase 3: Nonce 해제 (TX DROPPED/FAILED 시)
   *   해제된 Nonce는 다시 할당 가능 또는 빈 TX로 채움
   */
  async release(_address: string, _chainId: string, _nonce: number): Promise<void> {
    throw new Error('Phase 3 — NonceManager.release 구현 필요');
  }

  /**
   * Phase 3: Nonce 갭 감지
   *   온체인 confirmed Nonce와 pending Nonce 사이에 갭이 있으면 감지
   */
  async detectGap(
    _address: string,
    _chainId: string,
  ): Promise<{ hasGap: boolean; gapAt?: number }> {
    throw new Error('Phase 3 — NonceManager.detectGap 구현 필요');
  }

  /**
   * Phase 3: gas bump — 동일 Nonce로 gasPrice 1.2배 재전송 (EIP-1559: maxFee 증가)
   *   Replace-by-Fee: 동일 Nonce + maxPriorityFeePerGas 10%+ 인상
   */
  async bumpGas(
    _address: string,
    _chainId: string,
    _nonce: number,
    _bumpPercent: number,
  ): Promise<void> {
    throw new Error('Phase 3 — NonceManager.bumpGas 구현 필요');
  }
}
