/**
 * S23 채점 — 내부 원장 데이터 모델: 4개 테이블 구조 + ON CONFLICT DO NOTHING + SHA-256 checksum
 *
 * 채점 기준:
 *   · mint_requests: createMintRequest — REQUESTED 초기화, audit_log 기록
 *   · processed_events: recordProcessedEvent — ON CONFLICT DO NOTHING 멱등성
 *   · user_nft_holdings: addHolding — UNIQUE (userId, tokenId) 중복 방어
 *   · audit_log: _appendAuditLog — SHA-256 checksum 64자 hex
 */

import {
  LedgerService,
} from '../M4/S23_ledger_data_model';

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S23 채점 — Ledger 데이터 모델', () => {

  describe('mint_requests 테이블 — createMintRequest', () => {
    it('TODO: requestId가 UUID 형식(36자 hex-dash)이어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240001', 'WALK-10000');
      expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('TODO: 초기 status는 REQUESTED이어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240001', 'WALK-10000');
      expect(req.status).toBe('REQUESTED');
    });

    it('TODO: userId와 policyId가 올바르게 저장되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240001', 'WALK-10000');
      expect(req.userId).toBe('K-20240001');
      expect(req.policyId).toBe('WALK-10000');
    });

    it('TODO: 생성 직후 txHash, tokenId, blockNumber는 null이어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240001', 'WALK-10000');
      expect(req.txHash).toBeNull();
      expect(req.tokenId).toBeNull();
      expect(req.blockNumber).toBeNull();
    });

    it('TODO: updateMintRequestStatus로 SUBMITTED 전이 후 txHash가 설정되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240001', 'WALK-10000');
      await ledger.updateMintRequestStatus(req.requestId, 'SUBMITTED', { txHash: '0xabc123' });
      const updated = await ledger.getMintRequest(req.requestId);
      expect(updated?.status).toBe('SUBMITTED');
      expect(updated?.txHash).toBe('0xabc123');
    });

    it('TODO: MINED 전이 후 blockNumber가 bigint로 저장되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-1', 'WALK-10000');
      await ledger.updateMintRequestStatus(req.requestId, 'SUBMITTED', { txHash: '0xabc' });
      await ledger.updateMintRequestStatus(req.requestId, 'MINED', { blockNumber: 12345n });
      const mined = await ledger.getMintRequest(req.requestId);
      expect(mined?.blockNumber).toBe(12345n);
    });
  });

  describe('processed_events 테이블 — ON CONFLICT DO NOTHING 멱등성', () => {
    it('TODO: 첫 번째 삽입은 skipped=false이고 id가 할당되어야 한다', async () => {
      const ledger = new LedgerService();
      const r1 = await ledger.recordProcessedEvent('0x3f2a', 0, 'NFTIssued', 12345n, { tokenId: 1001 });
      expect(r1.skipped).toBe(false);
      expect(typeof r1.id).toBe('number');
    });

    it('TODO: 동일 (txHash, logIndex) 중복 삽입은 skipped=true이고 id가 없어야 한다', async () => {
      const ledger = new LedgerService();
      await ledger.recordProcessedEvent('0x3f2a', 0, 'NFTIssued', 12345n, { tokenId: 1001 });
      const r2 = await ledger.recordProcessedEvent('0x3f2a', 0, 'NFTIssued', 12345n, { tokenId: 1001 });
      expect(r2.skipped).toBe(true);
      expect(r2.id).toBeUndefined();
    });

    it('TODO: 동일 txHash라도 다른 logIndex는 별개 이벤트로 처리되어야 한다', async () => {
      const ledger = new LedgerService();
      const r1 = await ledger.recordProcessedEvent('0x3f2a', 0, 'NFTIssued', 12345n, { tokenId: 1001 });
      const r3 = await ledger.recordProcessedEvent('0x3f2a', 1, 'NFTIssued', 12345n, { tokenId: 1002 });
      expect(r3.skipped).toBe(false);
      expect(r1.id).not.toBe(r3.id);
    });
  });

  describe('user_nft_holdings 테이블 — UNIQUE (userId, tokenId) 중복 방어', () => {
    it('TODO: 동일 (userId, tokenId) 중복 addHolding은 무시되어야 한다', async () => {
      const ledger = new LedgerService();
      await ledger.addHolding('K-20240001', 1001n, 'WALK-10000');
      await ledger.addHolding('K-20240001', 1001n, 'WALK-10000');
      const holdings = await ledger.getHoldings('K-20240001');
      expect(holdings).toHaveLength(1);
    });

    it('TODO: getHoldings는 해당 userId의 보유 목록만 반환해야 한다', async () => {
      const ledger = new LedgerService();
      await ledger.addHolding('K-20240001', 1001n, 'WALK-10000');
      await ledger.addHolding('K-20240002', 1002n, 'WALK-10000');
      const h1 = await ledger.getHoldings('K-20240001');
      const h2 = await ledger.getHoldings('K-20240002');
      expect(h1).toHaveLength(1);
      expect(h2).toHaveLength(1);
      expect(h1[0]?.tokenId).toBe(1001n);
      expect(h2[0]?.tokenId).toBe(1002n);
    });

    it('TODO: 같은 userId의 서로 다른 tokenId는 각각 저장되어야 한다', async () => {
      const ledger = new LedgerService();
      await ledger.addHolding('K-20240001', 1001n, 'WALK-10000');
      await ledger.addHolding('K-20240001', 2001n, 'CYCLE-5000');
      const holdings = await ledger.getHoldings('K-20240001');
      expect(holdings).toHaveLength(2);
    });
  });

  describe('audit_log 테이블 — SHA-256 checksum 체인', () => {
    it('TODO: createMintRequest 후 MINT_REQUESTED 감사 로그가 기록되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240001', 'WALK-10000');
      const auditLog = ledger.getAuditLog();
      expect(auditLog.some(e => e.action === 'MINT_REQUESTED' && e.resourceId === req.requestId)).toBe(true);
    });

    it('TODO: audit_log의 모든 항목에 64자 hex checksum이 있어야 한다', async () => {
      const ledger = new LedgerService();
      await ledger.createMintRequest('K-20240001', 'WALK-10000');
      const auditLog = ledger.getAuditLog();
      expect(auditLog.every(e => e.checksum.length === 64)).toBe(true);
    });

    it('TODO: checksum은 SHA-256 hex 형식(소문자)이어야 한다', async () => {
      const ledger = new LedgerService();
      await ledger.createMintRequest('K-20240001', 'WALK-10000');
      const auditLog = ledger.getAuditLog();
      expect(auditLog.every(e => /^[0-9a-f]{64}$/.test(e.checksum))).toBe(true);
    });

    it('TODO: 상태 전이마다 audit_log 항목이 추가되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240003', 'CYCLE-5000');
      await ledger.updateMintRequestStatus(req.requestId, 'SUBMITTED', { txHash: '0xdef456' });
      await ledger.updateMintRequestStatus(req.requestId, 'MINED', { blockNumber: 12400n });
      await ledger.updateMintRequestStatus(req.requestId, 'FINALIZED');
      await ledger.updateMintRequestStatus(req.requestId, 'CONFIRMED', { tokenId: 2001n });
      const auditLog = ledger.getAuditLog();
      const actions = auditLog.map(e => e.action);
      expect(actions).toContain('MINT_REQUESTED');
      expect(actions).toContain('STATUS_SUBMITTED');
      expect(actions).toContain('STATUS_CONFIRMED');
    });
  });

  describe('전체 쓰기 경로 — REQUESTED → CONFIRMED 시뮬레이션', () => {
    it('TODO: 전체 상태 경로를 거쳐 최종 CONFIRMED가 되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240003', 'CYCLE-5000');
      await ledger.updateMintRequestStatus(req.requestId, 'SUBMITTED', { txHash: '0xdef456' });
      await ledger.updateMintRequestStatus(req.requestId, 'MINED', { blockNumber: 12400n });
      await ledger.updateMintRequestStatus(req.requestId, 'FINALIZED');
      const evResult = await ledger.recordProcessedEvent('0xdef456', 0, 'NFTIssued', 12400n, { tokenId: 2001 });
      if (!evResult.skipped) {
        await ledger.updateMintRequestStatus(req.requestId, 'CONFIRMED', { tokenId: 2001n });
        await ledger.addHolding('K-20240003', 2001n, 'CYCLE-5000');
      }
      const finalReq = await ledger.getMintRequest(req.requestId);
      expect(finalReq?.status).toBe('CONFIRMED');
      expect(finalReq?.tokenId).toBe(2001n);
    });

    it('TODO: 동일 이벤트 재처리 시 at-least-once 멱등성이 보장되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240003', 'CYCLE-5000');
      await ledger.updateMintRequestStatus(req.requestId, 'SUBMITTED', { txHash: '0xdef456' });
      await ledger.updateMintRequestStatus(req.requestId, 'MINED', { blockNumber: 12400n });
      await ledger.updateMintRequestStatus(req.requestId, 'FINALIZED');
      await ledger.recordProcessedEvent('0xdef456', 0, 'NFTIssued', 12400n, { tokenId: 2001 });
      await ledger.updateMintRequestStatus(req.requestId, 'CONFIRMED', { tokenId: 2001n });
      await ledger.addHolding('K-20240003', 2001n, 'CYCLE-5000');
      // 재처리
      const evDup = await ledger.recordProcessedEvent('0xdef456', 0, 'NFTIssued', 12400n, { tokenId: 2001 });
      expect(evDup.skipped).toBe(true);
    });

    it('TODO: holdings 중복 없이 1개만 등록되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('K-20240003', 'CYCLE-5000');
      await ledger.updateMintRequestStatus(req.requestId, 'SUBMITTED', { txHash: '0xdef456' });
      await ledger.updateMintRequestStatus(req.requestId, 'MINED', { blockNumber: 12400n });
      await ledger.updateMintRequestStatus(req.requestId, 'FINALIZED');
      const evResult = await ledger.recordProcessedEvent('0xdef456', 0, 'NFTIssued', 12400n, { tokenId: 2001 });
      if (!evResult.skipped) {
        await ledger.updateMintRequestStatus(req.requestId, 'CONFIRMED', { tokenId: 2001n });
        await ledger.addHolding('K-20240003', 2001n, 'CYCLE-5000');
      }
      const holdings = await ledger.getHoldings('K-20240003');
      expect(holdings).toHaveLength(1);
    });
  });
});
