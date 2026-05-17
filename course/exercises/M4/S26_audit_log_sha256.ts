/**
 * S26 실습 — 금융 규제 대응 감사 로그 · SHA-256 체인과 불변성 보장
 *
 * 강의 노트: M4_S26_audit_log_sha256.md
 *
 * 실행 방법 (루트에서): npm run exercise:s26
 *
 * 목표:
 *   [1] AuditLogService.log() — SHA-256 체인 방식 checksum 생성 + INSERT
 *   [2] verifyIntegrity(id) — 단건 무결성 검증
 *   [3] verifyChainIntegrity() — 전체 체인 순차 검증
 *   [4] 중간 레코드 DELETE 시 체인 불일치 감지
 *   [5] afterState 수정 시 감지
 *   [6] queryByResource / queryByActor 조회
 *   [7] prevChecksum Race Condition 이해 (단일 Writer 패턴)
 */

import { createHash } from 'crypto';

// ────────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────────

export interface LogParams {
  actor: string;
  action: string;
  resourceType?: string;
  resourceId: string;
  beforeState?: unknown;
  afterState: unknown;
  ipAddress?: string;
  sessionId?: string;
}

export interface AuditLogRow {
  id: number;
  eventTime: Date;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeState: unknown | null;
  afterState: unknown;
  ipAddress: string | null;
  sessionId: string | null;
  checksum: string;
}

export interface VerifyResult {
  id: number;
  valid: boolean;
  storedChecksum: string;
  computedChecksum: string;
}

export interface ChainVerifyResult {
  valid: boolean;
  firstInvalidId?: number;
  checkedCount: number;
}

export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'asc' | 'desc';
}

// ────────────────────────────────────────────────────────────────────────
// 실습: AuditLogService — SHA-256 체인 방식 감사 로그를 구현하라
//
// 체인 원리:
//   checksum_1 = SHA256('' + event1_data)
//   checksum_2 = SHA256(checksum_1 + event2_data)  ← 이전 checksum 포함
//   checksum_3 = SHA256(checksum_2 + event3_data)
//
// 중간 레코드를 삭제하거나 afterState를 수정하면 이후 모든 레코드의
// checksum이 불일치하므로 수학적으로 감지된다.
// ────────────────────────────────────────────────────────────────────────

export class AuditLogService {
  // 인메모리 "테이블" — 실제 PostgreSQL에서는 INSERT-only + RLS
  private rows: AuditLogRow[] = [];
  private seq = 0;

  // 단일 Writer 큐 — Race Condition 방지 (동일 프로세스 내) — 완성 제공
  // 실운영에서는 SELECT FOR UPDATE (트랜잭션 레벨 직렬화) 추가 필요
  private writeQueue: Promise<number> = Promise.resolve(0);

  // ────────────────────────────────────────────────────────────────────────
  // 실습 1: log()를 구현하라
  //
  // 단일 Writer 패턴: this.writeQueue 체인에 _doInsert를 연결
  // → this.writeQueue = this.writeQueue.then(() => this._doInsert(params))
  // → return this.writeQueue
  //
  // _doInsert 내부 구현:
  //   1. eventTime = new Date()
  //   2. 마지막 row의 checksum 조회: lastRow?.checksum ?? ''
  //   3. _generateChainedChecksum(prevChecksum, eventTime, actor, action, resourceId, afterState) 호출
  //   4. id = ++this.seq
  //   5. AuditLogRow 객체 생성 후 this.rows.push()
  //   6. id 반환
  // ────────────────────────────────────────────────────────────────────────

  async log(params: LogParams): Promise<number> {
    this.writeQueue = this.writeQueue.then(() => this._doInsert(params));
    return this.writeQueue;
  }

  private async _doInsert(params: LogParams): Promise<number> {
    return undefined as never;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 실습 2: verifyIntegrity(id)를 구현하라
  //
  // 1. this.rows.findIndex(r => r.id === id) — 없으면 Error throw
  // 2. 이전 row의 checksum 조회: idx > 0 ? this.rows[idx-1]?.checksum : ''
  // 3. _generateChainedChecksum() 으로 computedChecksum 계산
  // 4. { id, valid: storedChecksum === computedChecksum, storedChecksum, computedChecksum } 반환
  // ────────────────────────────────────────────────────────────────────────

  async verifyIntegrity(id: number): Promise<VerifyResult> {
    return undefined as never;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 실습 3: verifyChainIntegrity()를 구현하라
  //
  // 1. prevChecksum = '' (초기 seed)
  // 2. this.rows를 순서대로 순회하면서 각 row의 checksum 검증:
  //    - expected = _generateChainedChecksum(prevChecksum, row.eventTime, ...)
  //    - expected !== row.checksum → { valid: false, firstInvalidId: row.id, checkedCount }
  //    - 일치하면 prevChecksum = row.checksum 으로 업데이트
  // 3. 모두 통과 → { valid: true, checkedCount: this.rows.length }
  // ────────────────────────────────────────────────────────────────────────

  async verifyChainIntegrity(): Promise<ChainVerifyResult> {
    return undefined as never;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 실습 4: queryByResource를 구현하라
  //
  // 1. this.rows.filter(r => r.resourceId === resourceId)
  // 2. orderBy === 'asc' ? filtered : [...filtered].reverse()
  // 3. ordered.slice(offset, offset + limit)
  // 힌트: 기본값: limit=100, offset=0, orderBy='desc'
  // ────────────────────────────────────────────────────────────────────────

  queryByResource(resourceId: string, options: QueryOptions = {}): AuditLogRow[] {
    return undefined as never;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 실습 5: queryByActor를 구현하라
  //
  // queryByResource와 동일한 패턴, actor로 필터링
  // ────────────────────────────────────────────────────────────────────────

  queryByActor(actor: string, options: QueryOptions = {}): AuditLogRow[] {
    return undefined as never;
  }

  // ── 테스트 전용: 내부 rows 직접 조작 (변조 시뮬레이션) — 완성 제공 ──

  _dangerousDeleteRow(id: number): void {
    const idx = this.rows.findIndex(r => r.id === id);
    if (idx !== -1) this.rows.splice(idx, 1);
  }

  _dangerousModifyAfterState(id: number, newAfterState: unknown): void {
    const row = this.rows.find(r => r.id === id);
    if (row) row.afterState = newAfterState;
  }

  // ────────────────────────────────────────────────────────────────────────
  // SHA-256 체인 방식 checksum 생성 — 완성 제공 (변경하지 말 것)
  //
  // raw = [prevChecksum, eventTime.toISOString(), actor, action, resourceId, JSON.stringify(afterState)].join('')
  // checksum = SHA256(raw)
  // ────────────────────────────────────────────────────────────────────────

  private _generateChainedChecksum(
    prevChecksum: string,
    eventTime: Date,
    actor: string,
    action: string,
    resourceId: string,
    afterState: unknown,
  ): string {
    const raw = [
      prevChecksum,
      eventTime.toISOString(),
      actor,
      action,
      resourceId,
      JSON.stringify(afterState),
    ].join('');

    return createHash('sha256').update(raw, 'utf8').digest('hex');
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
  console.log('=== S26: SHA-256 체인 감사 로그 — 불변성 보장 ===\n');

  // ── [1] log() — 기본 삽입 + checksum 생성 ────────────────────────────
  console.log('[검증 1] log() — SHA-256 체인 checksum 생성');

  const auditLog = new AuditLogService();

  const id1 = await auditLog.log({
    actor: 'system:IssuerService',
    action: 'MINT_REQUESTED',
    resourceType: 'MintRequest',
    resourceId: 'req-001',
    afterState: { status: 'REQUESTED', userId: 'K-20240001' },
  });

  const id2 = await auditLog.log({
    actor: 'system',
    action: 'STATUS_SUBMITTED',
    resourceType: 'MintRequest',
    resourceId: 'req-001',
    beforeState: { status: 'REQUESTED' },
    afterState: { status: 'SUBMITTED', txHash: '0xabc0abc0abc0abc0abc0abc0abc0abc0abc0abc0abc0abc0abc0abc0abc0abc0' },
  });

  const id3 = await auditLog.log({
    actor: 'system',
    action: 'STATUS_CONFIRMED',
    resourceType: 'MintRequest',
    resourceId: 'req-001',
    afterState: { status: 'CONFIRMED', tokenId: 1001 },
  });

  check('id1 = 1',         id1 === 1);
  check('id2 = 2',         id2 === 2);
  check('id3 = 3',         id3 === 3);

  // ── [2] verifyIntegrity — 단건 검증 ──────────────────────────────────
  console.log('\n[검증 2] verifyIntegrity() — 단건 무결성 검증');

  const v1 = await auditLog.verifyIntegrity(id1);
  const v2 = await auditLog.verifyIntegrity(id2);
  const v3 = await auditLog.verifyIntegrity(id3);

  check('id1 valid = true',  v1.valid);
  check('id2 valid = true',  v2.valid);
  check('id3 valid = true',  v3.valid);
  check('checksum 64자 hex', v1.storedChecksum.length === 64);
  check('각 레코드 checksum 상이', v1.storedChecksum !== v2.storedChecksum);

  // ── [3] verifyChainIntegrity — 전체 체인 검증 ────────────────────────
  console.log('\n[검증 3] verifyChainIntegrity() — 전체 체인 검증');

  const chain1 = await auditLog.verifyChainIntegrity();
  check('체인 전체 valid = true',    chain1.valid);
  check('firstInvalidId 없음',       chain1.firstInvalidId === undefined);
  check('checkedCount = 3',          chain1.checkedCount === 3);

  // ── [4] 중간 레코드 DELETE → 체인 불일치 ─────────────────────────────
  console.log('\n[검증 4] 중간 레코드 DELETE → 체인 불일치 감지');

  auditLog._dangerousDeleteRow(id2);

  const chain2 = await auditLog.verifyChainIntegrity();
  check('체인 불일치 감지됨',        chain2.valid === false);
  check('firstInvalidId = id3',      chain2.firstInvalidId === id3);

  // ── [5] afterState 수정 → 체인 불일치 ────────────────────────────────
  console.log('\n[검증 5] afterState 수정 → 체인 불일치 감지');

  const auditLog2 = new AuditLogService();
  const aid1 = await auditLog2.log({
    actor: 'system', action: 'A', resourceId: 'r1',
    afterState: { status: 'PENDING' },
  });
  const aid2 = await auditLog2.log({
    actor: 'system', action: 'B', resourceId: 'r2',
    afterState: { status: 'DONE' },
  });

  const chain3 = await auditLog2.verifyChainIntegrity();
  check('수정 전: 체인 정상',         chain3.valid);

  auditLog2._dangerousModifyAfterState(aid1, { status: 'CONFIRMED' });

  const chain4 = await auditLog2.verifyChainIntegrity();
  check('afterState 수정 → 불일치',   chain4.valid === false);
  check('firstInvalidId = aid1',      chain4.firstInvalidId === aid1);

  // ── [6] queryByResource / queryByActor ───────────────────────────────
  console.log('\n[검증 6] queryByResource / queryByActor');

  const auditLog3 = new AuditLogService();
  await auditLog3.log({ actor: 'user-001',  action: 'LOGIN',    resourceId: 'session-1', afterState: {} });
  await auditLog3.log({ actor: 'system',    action: 'MINT',     resourceId: 'req-100',   afterState: { status: 'REQUESTED' } });
  await auditLog3.log({ actor: 'user-001',  action: 'LOGOUT',   resourceId: 'session-1', afterState: {} });
  await auditLog3.log({ actor: 'system',    action: 'CONFIRM',  resourceId: 'req-100',   afterState: { status: 'CONFIRMED' } });
  await auditLog3.log({ actor: 'user-002',  action: 'LOGIN',    resourceId: 'session-2', afterState: {} });

  const byResource = auditLog3.queryByResource('req-100', { orderBy: 'asc' });
  check('queryByResource: 2건',               byResource.length === 2);
  check('queryByResource: 첫 번째 action=MINT', byResource[0]?.action === 'MINT');
  check('queryByResource: 두 번째 action=CONFIRM', byResource[1]?.action === 'CONFIRM');

  const byActor = auditLog3.queryByActor('user-001', { orderBy: 'asc' });
  check('queryByActor user-001: 2건',         byActor.length === 2);
  check('queryByActor: LOGIN + LOGOUT',
    byActor.some(r => r.action === 'LOGIN') && byActor.some(r => r.action === 'LOGOUT'));

  const byActor2 = auditLog3.queryByActor('user-002');
  check('queryByActor user-002: 1건',         byActor2.length === 1);

  // ── [7] 단일 Writer — Race Condition 방지 ────────────────────────────
  console.log('\n[검증 7] 단일 Writer — 동시 log() 호출 시 체인 무결성 유지');

  const auditLog4 = new AuditLogService();

  const ids = await Promise.all([
    auditLog4.log({ actor: 'w1', action: 'E1', resourceId: 'r1', afterState: { i: 1 } }),
    auditLog4.log({ actor: 'w2', action: 'E2', resourceId: 'r2', afterState: { i: 2 } }),
    auditLog4.log({ actor: 'w3', action: 'E3', resourceId: 'r3', afterState: { i: 3 } }),
    auditLog4.log({ actor: 'w4', action: 'E4', resourceId: 'r4', afterState: { i: 4 } }),
    auditLog4.log({ actor: 'w5', action: 'E5', resourceId: 'r5', afterState: { i: 5 } }),
  ]);

  const chainConcurrent = await auditLog4.verifyChainIntegrity();
  check('동시 삽입 후 체인 무결성 유지', chainConcurrent.valid);
  check('5개 레코드 삽입됨',             chainConcurrent.checkedCount === 5);
  check('id 중복 없음',                  new Set(ids).size === 5);

  // ── [8] Append-only 원칙 — 보정은 새 INSERT로 ────────────────────────
  console.log('\n[검증 8] Append-only 보정 패턴');

  const auditLog5 = new AuditLogService();
  await auditLog5.log({ actor: 'system', action: 'MINT_REQUESTED', resourceId: 'req-200', afterState: { status: 'PENDING' } });
  await auditLog5.log({ actor: 'system', action: 'STATUS_CONFIRMED', resourceId: 'req-200', afterState: { status: 'CONFIRMED', txHash: '0x...' } });

  const correctionId = await auditLog5.log({
    actor: 'ops-team/reconcile-runbook',
    action: 'RECONCILE_CORRECTION',
    resourceId: 'req-200',
    afterState: { reason: 'consumer_delay', action_taken: 'waited_30min_resolved' },
  });

  const chain5 = await auditLog5.verifyChainIntegrity();
  check('보정 후에도 체인 무결성 유지',  chain5.valid);
  check('보정 레코드 포함 3개',          chain5.checkedCount === 3);

  const byReq = auditLog5.queryByResource('req-200', { orderBy: 'asc' });
  check('보정 포함 전체 이력 3건',       byReq.length === 3);
  check('마지막이 RECONCILE_CORRECTION', byReq[2]?.action === 'RECONCILE_CORRECTION');

  // ── 정리 ─────────────────────────────────────────────────────────────
  console.log('\n=== S26 실습 완료 ===');
  console.log(process.exitCode ? '❌ 일부 검증 실패' : '✅ 전체 통과');
  console.log('\n핵심 정리:');
  console.log('  1. SHA-256 체인: 이전 checksum이 다음 checksum 입력에 포함 → 중간 삭제 감지');
  console.log('  2. 중간 레코드 DELETE → 이후 레코드 checksum 연쇄 불일치');
  console.log('  3. afterState 수정 → 해당 레코드부터 체인 불일치');
  console.log('  4. prevChecksum Race Condition: SELECT FOR UPDATE로 해결 (실운영 필수)');
  console.log('  5. Append-only 원칙: 보정 = 기존 수정 금지, 새 INSERT로 이력 추가');
  console.log('  6. DB Row Security Policy: INSERT-only 정책으로 애플리케이션 우회 차단');
  console.log('  7. 대용량: verifyChainRange()로 구간 검증 (전체 스캔 OOM 방지)');
})();
