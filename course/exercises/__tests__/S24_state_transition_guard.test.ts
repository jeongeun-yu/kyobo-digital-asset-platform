/**
 * S24 채점 — 상태 전이 가드: VALID_TRANSITIONS 7개 상태 + InvalidStateTransitionError + 필드 유효성
 *
 * 채점 기준:
 *   · VALID_TRANSITIONS: 7개 MintStatus 전이 규칙 정의
 *   · 금지 전이 → InvalidStateTransitionError
 *   · 종단 상태 (CONFIRMED, FAILED): 전이 목록 비어 있음
 *   · 필드 유효성: SUBMITTED txHash 필수 / CONFIRMED tokenId 필수
 *   · recordProcessedEvent 멱등성
 *   · handleNFTIssued 중복 이벤트 차단 (processed=false)
 *   · REORGED → MINED 복귀 정상 전이
 */

import {
  LedgerService,
  InvalidStateTransitionError,
  MintRequestNotFoundError,
  handleNFTIssued,
} from '../M4/S24_state_transition_guard';

// ── 채점 테스트 ───────────────────────────────────────────────────────────────

describe('S24 채점 — 상태 전이 가드', () => {

  describe('정상 전이 — REQUESTED → CONFIRMED 전체 경로', () => {
    it('TODO: REQUESTED → SUBMITTED 전이가 성공해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-1', 'WALK-10000');
      const sub = await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xabc123' });
      expect(sub.status).toBe('SUBMITTED');
      expect(sub.txHash).toBe('0xabc123');
    });

    it('TODO: SUBMITTED → MINED 전이가 성공해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-1', 'WALK-10000');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xabc' });
      const mined = await ledger.updateMintRequest(req.requestId, { status: 'MINED', blockNumber: 12345n });
      expect(mined.status).toBe('MINED');
    });

    it('TODO: MINED → FINALIZED 전이가 성공해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-1', 'WALK-10000');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xabc' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      const fin = await ledger.updateMintRequest(req.requestId, { status: 'FINALIZED' });
      expect(fin.status).toBe('FINALIZED');
    });

    it('TODO: MINED → REORGED 전이가 성공해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-reorg', 'WALK-10000');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xreorg' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      const reorged = await ledger.updateMintRequest(req.requestId, { status: 'REORGED' });
      expect(reorged.status).toBe('REORGED');
    });

    it('TODO: REORGED → MINED 복귀 전이가 성공해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-reorg', 'WALK-10000');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xreorg' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      await ledger.updateMintRequest(req.requestId, { status: 'REORGED' });
      const restored = await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      expect(restored.status).toBe('MINED');
    });
  });

  describe('금지 전이 — InvalidStateTransitionError', () => {
    it('TODO: CONFIRMED 종단 상태에서 SUBMITTED 전이 시 InvalidStateTransitionError가 발생해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-conf', 'WALK');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xconf' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      await ledger.updateMintRequest(req.requestId, { status: 'FINALIZED' });
      await ledger.updateMintRequest(req.requestId, { status: 'CONFIRMED', tokenId: 9001n, txHash: '0xconf' });
      await expect(
        ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED' }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('TODO: FAILED 종단 상태에서 CONFIRMED 전이 시 InvalidStateTransitionError가 발생해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-fail', 'WALK');
      await ledger.updateMintRequest(req.requestId, { status: 'FAILED', errorMsg: 'REVERT' });
      await expect(
        ledger.updateMintRequest(req.requestId, { status: 'CONFIRMED', tokenId: 1n }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('TODO: MINED → CONFIRMED (FINALIZED 건너뜀) 시 InvalidStateTransitionError가 발생해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-mined', 'WALK');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xmined' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      await expect(
        ledger.updateMintRequest(req.requestId, { status: 'CONFIRMED', tokenId: 1n }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('TODO: REORGED → CONFIRMED 직접 전이 시 InvalidStateTransitionError가 발생해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-reorg2', 'WALK');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xr2' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      await ledger.updateMintRequest(req.requestId, { status: 'REORGED' });
      await expect(
        ledger.updateMintRequest(req.requestId, { status: 'CONFIRMED', tokenId: 1n }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('TODO: 존재하지 않는 requestId → MintRequestNotFoundError가 발생해야 한다', async () => {
      const ledger = new LedgerService();
      await expect(
        ledger.updateMintRequest('not-exist-uuid', { status: 'SUBMITTED' }),
      ).rejects.toThrow(MintRequestNotFoundError);
    });
  });

  describe('필드 유효성 가드 — 상태 필수 필드 검증', () => {
    it('TODO: SUBMITTED 전이 시 txHash가 없으면 에러가 발생해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-2', 'WALK-10000');
      await expect(
        ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED' }),
      ).rejects.toThrow();
    });

    it('TODO: CONFIRMED 전이 시 tokenId가 없으면 에러가 발생해야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-2', 'WALK-10000');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xvalid' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      await ledger.updateMintRequest(req.requestId, { status: 'FINALIZED' });
      await expect(
        ledger.updateMintRequest(req.requestId, { status: 'CONFIRMED' }),
      ).rejects.toThrow();
    });
  });

  describe('멱등성 — recordProcessedEvent', () => {
    it('TODO: 첫 번째 처리는 skipped=false이어야 한다', async () => {
      const ledger = new LedgerService();
      const r1 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});
      expect(r1.skipped).toBe(false);
    });

    it('TODO: 중복 (txHash, logIndex) 처리는 skipped=true, id 없음이어야 한다', async () => {
      const ledger = new LedgerService();
      await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});
      const r2 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});
      expect(r2.skipped).toBe(true);
      expect(r2.id).toBeUndefined();
    });

    it('TODO: 같은 txHash 다른 logIndex는 별개 이벤트이어야 한다', async () => {
      const ledger = new LedgerService();
      const r1 = await ledger.recordProcessedEvent('0xabc', 0, 'NFTIssued', 100n, {});
      const r3 = await ledger.recordProcessedEvent('0xabc', 1, 'NFTIssued', 100n, {});
      expect(r3.skipped).toBe(false);
      expect(r1.id).not.toBe(r3.id);
    });
  });

  describe('handleNFTIssued — 중복 이벤트 차단', () => {
    it('TODO: 첫 번째 처리 시 processed=true이어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-evt', 'CYCLE-5000');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xevt' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      await ledger.updateMintRequest(req.requestId, { status: 'FINALIZED' });
      const evt = { txHash: '0xevt', logIndex: 0, blockNumber: 12500n, tokenId: 3001n, userId: 'user-evt', policyId: 'CYCLE-5000', requestId: req.requestId };
      const result1 = await handleNFTIssued(ledger, evt);
      expect(result1.processed).toBe(true);
    });

    it('TODO: 처리 후 최종 status=CONFIRMED, tokenId가 확정되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-evt', 'CYCLE-5000');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xevt' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      await ledger.updateMintRequest(req.requestId, { status: 'FINALIZED' });
      const evt = { txHash: '0xevt', logIndex: 0, blockNumber: 12500n, tokenId: 3001n, userId: 'user-evt', policyId: 'CYCLE-5000', requestId: req.requestId };
      await handleNFTIssued(ledger, evt);
      const finalReq = await ledger.getMintRequest(req.requestId);
      expect(finalReq?.status).toBe('CONFIRMED');
      expect(finalReq?.tokenId).toBe(3001n);
    });

    it('TODO: 동일 이벤트 재처리 시 processed=false이어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-evt', 'CYCLE-5000');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xevt' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      await ledger.updateMintRequest(req.requestId, { status: 'FINALIZED' });
      const evt = { txHash: '0xevt', logIndex: 0, blockNumber: 12500n, tokenId: 3001n, userId: 'user-evt', policyId: 'CYCLE-5000', requestId: req.requestId };
      await handleNFTIssued(ledger, evt);
      const result2 = await handleNFTIssued(ledger, evt);
      expect(result2.processed).toBe(false);
    });

    it('TODO: 재처리 후 상태 변화 없이 CONFIRMED가 유지되어야 한다', async () => {
      const ledger = new LedgerService();
      const req = await ledger.createMintRequest('user-evt', 'CYCLE-5000');
      await ledger.updateMintRequest(req.requestId, { status: 'SUBMITTED', txHash: '0xevt' });
      await ledger.updateMintRequest(req.requestId, { status: 'MINED' });
      await ledger.updateMintRequest(req.requestId, { status: 'FINALIZED' });
      const evt = { txHash: '0xevt', logIndex: 0, blockNumber: 12500n, tokenId: 3001n, userId: 'user-evt', policyId: 'CYCLE-5000', requestId: req.requestId };
      await handleNFTIssued(ledger, evt);
      await handleNFTIssued(ledger, evt);
      const afterDup = await ledger.getMintRequest(req.requestId);
      expect(afterDup?.status).toBe('CONFIRMED');
    });
  });
});
