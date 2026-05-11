/**
 * S23 실습 — 온체인만으로 부족한 이유 · 내부 원장 필요성과 데이터 모델 설계
 *
 * 강의 노트: M4_S23_ledger_data_model.md
 *
 * 실행 방법 (루트에서): npm run exercise:s23
 *
 * 목표:
 *   [1] 4개 테이블(mint_requests / processed_events / user_nft_holdings / audit_log) 인메모리 구현
 *   [2] createMintRequest — INSERT + audit 기록
 *   [3] recordProcessedEvent — ON CONFLICT DO NOTHING 시뮬레이션 (멱등성)
 *   [4] addHolding — UNIQUE (user_id, token_id) 중복 방어
 *   [5] 쓰기 경로 전체 흐름 시뮬레이션
 */

import { createHash, randomUUID } from 'crypto';

// ────────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────────

export type MintStatus =
  | 'REQUESTED'
  | 'SUBMITTED'
  | 'MINED'
  | 'CONFIRMED'
  | 'FINALIZED'
  | 'REORGED'
  | 'FAILED';

export interface MintRequest {
  requestId: string;
  userId: string;
  policyId: string;
  status: MintStatus;
  txHash: string | null;
  tokenId: bigint | null;
  blockNumber: bigint | null;
  errorMsg: string | null;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProcessedEvent {
  id: number;
  txHash: string;
  logIndex: number;
  eventName: string;
  blockNumber: bigint;
  payload: unknown;
  processedAt: Date;
}

export interface UserNftHolding {
  id: number;
  userId: string;
  tokenId: bigint;
  policyId: string;
  acquiredAt: Date;
}

export interface AuditLogEntry {
  id: number;
  eventTime: Date;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeState: unknown | null;
  afterState: unknown;
  checksum: string;
}

export interface ProcessedEventResult {
  skipped: boolean;
  id?: number;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 1: LedgerService 인메모리 구현
//
// 실제 PostgreSQL 대신 Map/배열로 테이블을 시뮬레이션한다.
// ON CONFLICT DO NOTHING은 중복 키 조회 후 조기 반환으로 구현한다.
// ────────────────────────────────────────────────────────────────────────

export class LedgerService {
  // ── 인메모리 "테이블" ──────────────────────────────────────────────────
  private mintRequests  = new Map<string, MintRequest>();           // PK: requestId
  private processedEvents: ProcessedEvent[] = [];                   // UNIQUE: (txHash, logIndex)
  private userNftHoldings: UserNftHolding[] = [];                   // UNIQUE: (userId, tokenId)
  private auditLog: AuditLogEntry[] = [];

  private processedEventSeq = 0;
  private holdingSeq = 0;
  private auditSeq = 0;

  // ── mint_requests ──────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────
  // 실습 2: createMintRequest를 구현하라
  //
  // 1. randomUUID()로 requestId 생성
  // 2. 초기 status = 'REQUESTED', txHash/tokenId/blockNumber/errorMsg = null
  // 3. this.mintRequests.set(requestId, req) 으로 저장
  // 4. _appendAuditLog() 호출하여 감사 로그 기록
  //    - actor: 'system:IssuerService', action: 'MINT_REQUESTED'
  //    - resourceType: 'mint_request', resourceId: requestId
  //    - beforeState: null, afterState: { status: 'REQUESTED', userId, policyId }
  // 5. { ...req } (복사본) 반환
  // ────────────────────────────────────────────────────────────────────────

  async createMintRequest(userId: string, policyId: string): Promise<MintRequest> {
    return undefined as never;
  }

  async getMintRequest(requestId: string): Promise<MintRequest | null> {
    const req = this.mintRequests.get(requestId);
    return req ? { ...req } : null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 실습 3: updateMintRequestStatus를 구현하라
  //
  // 1. this.mintRequests.get(requestId) — 없으면 Error throw
  // 2. req.status = status, req.updatedAt = new Date()
  // 3. extra 필드(txHash/tokenId/blockNumber/errorMsg)가 undefined가 아닌 경우에만 업데이트
  //    힌트: if (extra?.txHash !== undefined) req.txHash = extra.txHash;
  // 4. this.mintRequests.set(requestId, req) 으로 저장
  // 5. _appendAuditLog() 호출
  //    - actor: 'system', action: `STATUS_${status}`
  //    - beforeState: { status: before.status }, afterState: { status, ...extra }
  // ────────────────────────────────────────────────────────────────────────

  async updateMintRequestStatus(
    requestId: string,
    status: MintStatus,
    extra?: {
      txHash?: string;
      tokenId?: bigint;
      blockNumber?: bigint;
      errorMsg?: string;
    },
  ): Promise<void> {
    return undefined as never;
  }

  // ── processed_events — ON CONFLICT DO NOTHING 시뮬레이션 ──────────────
  // ────────────────────────────────────────────────────────────────────────
  // 실습 4: recordProcessedEvent를 구현하라
  //
  // UNIQUE 제약: (txHash, logIndex) 조합이 중복이면 { skipped: true } 반환
  //
  // 1. this.processedEvents.some()으로 (txHash, logIndex) 중복 확인
  // 2. 중복이면 즉시 { skipped: true } 반환
  // 3. 신규이면:
  //    - id = ++this.processedEventSeq
  //    - this.processedEvents.push({ id, txHash, logIndex, eventName, blockNumber, payload, processedAt: new Date() })
  //    - { skipped: false, id } 반환
  // ────────────────────────────────────────────────────────────────────────

  async recordProcessedEvent(
    txHash: string,
    logIndex: number,
    eventName: string,
    blockNumber: bigint,
    payload: unknown,
  ): Promise<ProcessedEventResult> {
    return undefined as never;
  }

  // ── user_nft_holdings — UNIQUE (userId, tokenId) 중복 방어 ─────────────
  // ────────────────────────────────────────────────────────────────────────
  // 실습 5: addHolding을 구현하라
  //
  // UNIQUE 제약: (userId, tokenId) 조합이 중복이면 조용히 무시 (return)
  //
  // 1. this.userNftHoldings.some()으로 중복 확인
  // 2. 중복이면 return (아무것도 하지 않음)
  // 3. 신규이면:
  //    - id = ++this.holdingSeq
  //    - this.userNftHoldings.push({ id, userId, tokenId, policyId, acquiredAt: new Date() })
  // ────────────────────────────────────────────────────────────────────────

  async addHolding(userId: string, tokenId: bigint, policyId: string): Promise<void> {
    return undefined as never;
  }

  async getHoldings(userId: string): Promise<UserNftHolding[]> {
    return this.userNftHoldings.filter(h => h.userId === userId);
  }

  // ── audit_log — INSERT-only ────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────
  // 실습 6: _appendAuditLog를 구현하라 (private 메서드)
  //
  // checksum = SHA-256(eventTime.toISOString() + actor + action + resourceId + JSON.stringify(afterState))
  //
  // 1. id = ++this.auditSeq, eventTime = new Date()
  // 2. BigInt를 문자열로 변환하는 safeStringify 함수 정의:
  //    JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val))
  // 3. raw = [eventTime.toISOString(), actor, action, resourceId, safeStringify(afterState)].join('')
  // 4. checksum = createHash('sha256').update(raw, 'utf8').digest('hex')
  // 5. this.auditLog.push({ id, eventTime, actor, action, resourceType, resourceId, beforeState, afterState, checksum })
  // ────────────────────────────────────────────────────────────────────────

  private async _appendAuditLog(params: {
    actor: string;
    action: string;
    resourceType: string;
    resourceId: string;
    beforeState: unknown | null;
    afterState: unknown;
  }): Promise<void> {
    return undefined as never;
  }

  getAuditLog(): AuditLogEntry[] {
    return [...this.auditLog];
  }
}

// ────────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────────

function check(label: string, pass: boolean) {
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}`);
  if (!pass) process.exitCode = 1;
}

// ────────────────────────────────────────────────────────────────────────
// 실습 진입점
// ────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== S23: 내부 원장 데이터 모델 — 4개 테이블 설계 ===\n');

  const ledger = new LedgerService();

  // ── [1] mint_requests — createMintRequest ────────────────────────────
  console.log('[검증 1] mint_requests — createMintRequest');

  const req = await ledger.createMintRequest('K-20240001', 'WALK-10000');
  check('requestId UUID 형식',       /^[0-9a-f-]{36}$/.test(req.requestId));
  check('초기 status = REQUESTED',   req.status === 'REQUESTED');
  check('userId 일치',               req.userId === 'K-20240001');
  check('policyId 일치',             req.policyId === 'WALK-10000');
  check('txHash = null (아직)',       req.txHash === null);
  check('tokenId = null (아직)',      req.tokenId === null);

  // audit_log 기록 확인
  const auditAfterCreate = ledger.getAuditLog();
  check('audit_log: MINT_REQUESTED 기록됨',
    auditAfterCreate.some(e => e.action === 'MINT_REQUESTED' && e.resourceId === req.requestId));
  check('audit_log: checksum 존재',
    auditAfterCreate.every(e => e.checksum.length === 64));

  // ── [2] updateMintRequestStatus ─────────────────────────────────────
  console.log('\n[검증 2] updateMintRequestStatus — SUBMITTED 전이');

  await ledger.updateMintRequestStatus(req.requestId, 'SUBMITTED', { txHash: '0xabc123' });
  const submitted = await ledger.getMintRequest(req.requestId);
  check('status = SUBMITTED',         submitted?.status === 'SUBMITTED');
  check('txHash 설정됨',               submitted?.txHash === '0xabc123');

  await ledger.updateMintRequestStatus(req.requestId, 'MINED', { blockNumber: 12345n });
  const mined = await ledger.getMintRequest(req.requestId);
  check('status = MINED',             mined?.status === 'MINED');
  check('blockNumber 설정됨',         mined?.blockNumber === 12345n);

  await ledger.updateMintRequestStatus(req.requestId, 'CONFIRMED', { tokenId: 1001n });
  const confirmed = await ledger.getMintRequest(req.requestId);
  check('status = CONFIRMED',         confirmed?.status === 'CONFIRMED');
  check('tokenId 설정됨',             confirmed?.tokenId === 1001n);

  // ── [3] recordProcessedEvent — ON CONFLICT DO NOTHING ────────────────
  console.log('\n[검증 3] recordProcessedEvent — 멱등성 보장');

  const r1 = await ledger.recordProcessedEvent('0x3f2a', 0, 'NFTIssued', 12345n, { tokenId: 1001 });
  const r2 = await ledger.recordProcessedEvent('0x3f2a', 0, 'NFTIssued', 12345n, { tokenId: 1001 });  // 중복
  const r3 = await ledger.recordProcessedEvent('0x3f2a', 1, 'NFTIssued', 12345n, { tokenId: 1002 });  // 다른 logIndex

  check('첫 번째 삽입: skipped = false',    r1.skipped === false);
  check('첫 번째 삽입: id 할당됨',           typeof r1.id === 'number');
  check('중복 이벤트: skipped = true',       r2.skipped === true);
  check('중복 이벤트: id 없음',              r2.id === undefined);
  check('다른 logIndex: skipped = false',    r3.skipped === false);
  check('다른 logIndex는 별개 이벤트',       r1.id !== r3.id);

  // ── [4] addHolding — UNIQUE (userId, tokenId) ─────────────────────────
  console.log('\n[검증 4] addHolding — 중복 보유 방지');

  await ledger.updateMintRequestStatus(req.requestId, 'FINALIZED');
  await ledger.addHolding('K-20240001', 1001n, 'WALK-10000');
  await ledger.addHolding('K-20240001', 1001n, 'WALK-10000');  // 중복 시도

  const holdings = await ledger.getHoldings('K-20240001');
  check('holdings 1개 (중복 제거됨)', holdings.length === 1);
  check('tokenId 일치',               holdings[0]?.tokenId === 1001n);
  check('userId 일치',                holdings[0]?.userId === 'K-20240001');

  // 다른 사용자, 다른 토큰
  await ledger.addHolding('K-20240002', 1002n, 'WALK-10000');
  const holdings2 = await ledger.getHoldings('K-20240002');
  check('다른 사용자 holdings 독립 관리', holdings2.length === 1);

  // ── [5] 전체 쓰기 경로 시뮬레이션 ────────────────────────────────────
  console.log('\n[검증 5] 전체 쓰기 경로 — REQUESTED → FINALIZED');

  const req2 = await ledger.createMintRequest('K-20240003', 'CYCLE-5000');
  await ledger.updateMintRequestStatus(req2.requestId, 'SUBMITTED', { txHash: '0xdef456' });
  await ledger.updateMintRequestStatus(req2.requestId, 'MINED', { blockNumber: 12400n });

  // ConsumerGroupWorker 처리
  const evResult = await ledger.recordProcessedEvent('0xdef456', 0, 'NFTIssued', 12400n, { tokenId: 2001 });
  if (!evResult.skipped) {
    await ledger.updateMintRequestStatus(req2.requestId, 'CONFIRMED', { tokenId: 2001n });
    await ledger.addHolding('K-20240003', 2001n, 'CYCLE-5000');
  }

  // PoS Finality 확인 후 종단 전이
  await ledger.updateMintRequestStatus(req2.requestId, 'FINALIZED');

  const finalReq = await ledger.getMintRequest(req2.requestId);
  const finalHoldings = await ledger.getHoldings('K-20240003');
  check('최종 status = FINALIZED',    finalReq?.status === 'FINALIZED');
  check('tokenId 확정됨',             finalReq?.tokenId === 2001n);
  check('holdings 등록됨',            finalHoldings.length === 1);

  // 재처리 시뮬레이션 (at-least-once)
  const evDup = await ledger.recordProcessedEvent('0xdef456', 0, 'NFTIssued', 12400n, { tokenId: 2001 });
  check('재처리 시 skipped = true',   evDup.skipped === true);

  // audit_log 전체 기록 확인
  const allAudit = ledger.getAuditLog();
  check('audit_log 최소 8개 이상 기록', allAudit.length >= 8);
  const actions = allAudit.map(e => e.action);
  check('MINT_REQUESTED 포함',         actions.includes('MINT_REQUESTED'));
  check('STATUS_SUBMITTED 포함',       actions.includes('STATUS_SUBMITTED'));
  check('STATUS_CONFIRMED 포함',       actions.includes('STATUS_CONFIRMED'));

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S23 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. 온체인은 단일 진실(source of truth), 오프체인 원장은 온체인에서 파생된 캐시');
  console.log('  2. ON CONFLICT DO NOTHING + RETURNING id: rows.length===0 → 중복 이벤트');
  console.log('  3. SELECT-then-INSERT는 동시성 문제 → DB UNIQUE 제약이 유일한 안전 방법');
  console.log('  4. 4개 테이블: mint_requests(진행 추적) / processed_events(중복 방지) / user_nft_holdings(캐시) / audit_log(불변 기록)');
  console.log('  5. 역방향 수정(원장→온체인) 절대 금지 — 보안 취약점');
})();
