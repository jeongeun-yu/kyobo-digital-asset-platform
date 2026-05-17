/**
 * @kyobo/vasp — 실습용 테스트 헬퍼
 *
 * 실제 DB·VASP 없이 실습 코드를 실행할 수 있게 해주는 인메모리 구현체.
 * 운영 코드에서 import하지 말 것.
 */

import type {
  TxRepository,
  MintRequest,
  TxStatus,
  WalletResolver,
} from '../tx/TxStateMachineService';

import { InvalidStateTransitionError } from '../recovery/VaspRecoveryService';
export { InvalidStateTransitionError };

// ── InMemoryLedger (VaspRecoveryService 의존성) ───────────────────────────

type LedgerRecord = {
  id:        string;
  status:    string;
  txHash?:   string;
  errorMsg?: string;
  [key: string]: unknown;
};

const LEDGER_VALID: Record<string, string[]> = {
  REQUESTED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['PENDING', 'MINED', 'FAILED'],
  PENDING:   ['MINED', 'FAILED'],
  MINED:     ['CONFIRMED', 'REORGED', 'FAILED'],
  CONFIRMED: ['FINALIZED'],
  FINALIZED: [],
  FAILED:    [],
  REORGED:   ['MINED', 'FAILED'],
};

export class InMemoryLedger {
  private store = new Map<string, LedgerRecord>();

  async saveMintRequest(req: LedgerRecord): Promise<void> {
    this.store.set(req.id, { ...req });
  }

  async getMintRequest(id: string): Promise<LedgerRecord | null> {
    return this.store.get(id) ?? null;
  }

  async reverseMintCredit(_requestId: string): Promise<void> {
    // TODO: Phase 3 — 원장 역분개 구현 필요 (CONFIRMED → REORGED 전이 시 호출)
  }

  async notifyUserCreditReversed(_requestId: string): Promise<void> {
    // TODO: 설계 숙제 — 사용자 롤백 통보 방식 및 보상 플로우 설계 필요
  }

  async updateMintRequest(
    id: string,
    patch: { status: string; txHash?: string; errorMsg?: string; [key: string]: unknown },
  ): Promise<LedgerRecord> {
    const current = this.store.get(id);
    if (!current) throw new Error(`MintRequest not found: ${id}`);

    const allowed = LEDGER_VALID[current.status] ?? [];
    if (!allowed.includes(patch.status)) {
      throw new InvalidStateTransitionError(current.status, patch.status);
    }

    const updated = { ...current, ...patch, updatedAt: new Date() };
    this.store.set(id, updated);
    return updated;
  }
}

// ── MockVaspClient (VaspRecoveryService 의존성) ───────────────────────────

export class MockVaspClient {
  async resyncNonce(): Promise<void> {}
  async resubmit(_requestId: string): Promise<{ txHash: string }> {
    return { txHash: `0xREBUMPED_${Date.now().toString(16)}` };
  }
  async submitMint(_params: {
    to: string; tokenId: bigint; amount: bigint; requestId: string;
  }): Promise<{ txHash: string }> {
    return { txHash: `0xMOCK_${Date.now().toString(16)}` };
  }
  async getStatus(_txHash: string) {
    return { status: 'pending' as const };
  }
  async resubmitWithGasBump(_txHash: string, _pct: number) {
    return { txHash: `0xBUMP_${Date.now().toString(16)}` };
  }
}

// ── MockNotifier (VaspRecoveryService 의존성) ─────────────────────────────

export class MockNotifier {
  sentEvents: Array<{ type: string; [key: string]: unknown }> = [];

  async send(event: { type: string; [key: string]: unknown }): Promise<void> {
    this.sentEvents.push(event);
  }
}

// ── InMemoryTxRepository (TxStateMachineService 의존성) ───────────────────

export class InMemoryTxRepository implements TxRepository {
  private store = new Map<string, MintRequest>();

  async save(req: MintRequest): Promise<void> {
    this.store.set(req.id, { ...req });
  }

  async findById(id: string): Promise<MintRequest | null> {
    return this.store.get(id) ?? null;
  }

  async updateStatus(
    id: string,
    status: TxStatus,
    extra?: Partial<MintRequest>,
  ): Promise<void> {
    const r = this.store.get(id);
    if (r) this.store.set(id, { ...r, ...extra, status, updatedAt: new Date() });
  }

  async findPendingOlderThan(_minutes: number): Promise<MintRequest[]> {
    return [];
  }
}

// ── MockWalletResolver (TxStateMachineService 의존성) ─────────────────────

export class MockWalletResolver implements WalletResolver {
  async getWalletAddr(userId: string): Promise<string> {
    return `0x${userId.slice(0, 8).padEnd(40, '0')}`;
  }
}
