/**
 * S50 채점 — 장애 주입 기반 복원력 검증: VASP 중단·Reorg·Consumer 크래시
 *
 * 채점 기준:
 *   · 지수 백오프: VASP 3회 실패 → 4회째 성공, 호출 횟수 검증
 *   · VASP 5회 전부 실패 → FAILED + DLQ 적재
 *   · REORG 복구: REORGED → 재채굴 → CONFIRMED
 *   · Consumer 크래시 멱등성: 동일 이벤트 2회 처리 → 원장 1회 업데이트
 *   · 1-of-3 Safe 차단 / 2-of-3 Safe 성공
 */

import {
  MockLedgerService,
  MockDLQService,
  MockVaspApiClient,
  withExponentialBackoff,
  MockIssuerService,
  SimpleSafe,
  MockRedisStream,
} from '../M8/S50_fault_injection';

// ─── 채점 테스트 ─────────────────────────────────────────────────────────────

describe('S50 채점 — 장애 주입 기반 복원력 검증', () => {

  describe('TODO: 지수 백오프 — withExponentialBackoff 동작 검증', () => {
    it('실패 없으면 1회 호출로 성공', async () => {
      let callCount = 0;
      const result = await withExponentialBackoff(
        async () => { callCount++; return 'ok'; },
        { maxRetries: 3, baseDelayMs: 0 },
      );
      expect(result).toBe('ok');
      expect(callCount).toBe(1);
    });

    it('2회 실패 후 3회째 성공 → 총 3회 호출', async () => {
      let callCount = 0;
      const result = await withExponentialBackoff(
        async () => {
          callCount++;
          if (callCount < 3) throw new Error('transient');
          return 'recovered';
        },
        { maxRetries: 5, baseDelayMs: 0 },
      );
      expect(result).toBe('recovered');
      expect(callCount).toBe(3);
    });

    it('maxRetries 초과 → 마지막 에러 throw', async () => {
      await expect(
        withExponentialBackoff(
          async () => { throw new Error('persistent'); },
          { maxRetries: 2, baseDelayMs: 0 },
        ),
      ).rejects.toThrow('persistent');
    });

    it('maxRetries=2 초과 시 총 3회 호출 (1 + 2회 재시도)', async () => {
      let callCount = 0;
      await withExponentialBackoff(
        async () => { callCount++; throw new Error('fail'); },
        { maxRetries: 2, baseDelayMs: 0 },
      ).catch(() => {});
      expect(callCount).toBe(3);
    });
  });

  describe('TODO: VASP 3회 실패 → 4회째 성공', () => {
    it('result.success = true', async () => {
      const ledger = new MockLedgerService();
      const vasp   = new MockVaspApiClient(3);
      const dlq    = new MockDLQService();
      const issuer = new MockIssuerService(vasp, ledger, dlq, 0);
      const req    = await ledger.createMintRequest({ userId: 'u-1', tokenId: 1n, amount: 1n, activityId: 'a-1' });

      const result = await issuer.issueSingleWithRetry({ to: '0xW1', tokenId: req.tokenId, amount: req.amount, requestId: req.id, maxRetries: 5 });
      expect(result.success).toBe(true);
    });

    it('총 호출 횟수: 4 (3회 실패 + 1회 성공)', async () => {
      const ledger = new MockLedgerService();
      const vasp   = new MockVaspApiClient(3);
      const dlq    = new MockDLQService();
      const issuer = new MockIssuerService(vasp, ledger, dlq, 0);
      const req    = await ledger.createMintRequest({ userId: 'u-2', tokenId: 2n, amount: 1n, activityId: 'a-2' });

      await issuer.issueSingleWithRetry({ to: '0xW2', tokenId: req.tokenId, amount: req.amount, requestId: req.id, maxRetries: 5 });
      expect(vasp.getCallCount()).toBe(4);
    });

    it('성공 시 DLQ 적재 없음', async () => {
      const ledger = new MockLedgerService();
      const vasp   = new MockVaspApiClient(3);
      const dlq    = new MockDLQService();
      const issuer = new MockIssuerService(vasp, ledger, dlq, 0);
      const req    = await ledger.createMintRequest({ userId: 'u-3', tokenId: 3n, amount: 1n, activityId: 'a-3' });

      await issuer.issueSingleWithRetry({ to: '0xW3', tokenId: req.tokenId, amount: req.amount, requestId: req.id, maxRetries: 5 });
      expect(dlq.count()).toBe(0);
    });

    it('복구 성공 후 원장 상태: SUBMITTED', async () => {
      const ledger = new MockLedgerService();
      const vasp   = new MockVaspApiClient(3);
      const dlq    = new MockDLQService();
      const issuer = new MockIssuerService(vasp, ledger, dlq, 0);
      const req    = await ledger.createMintRequest({ userId: 'u-4', tokenId: 4n, amount: 1n, activityId: 'a-4' });

      await issuer.issueSingleWithRetry({ to: '0xW4', tokenId: req.tokenId, amount: req.amount, requestId: req.id, maxRetries: 5 });
      expect((await ledger.get(req.id))?.status).toBe('SUBMITTED');
    });
  });

  describe('TODO: VASP 5회 전부 실패 → FAILED + DLQ', () => {
    async function makeFailedSetup() {
      const ledger = new MockLedgerService();
      const vasp   = new MockVaspApiClient(99);
      const dlq    = new MockDLQService();
      const issuer = new MockIssuerService(vasp, ledger, dlq, 0);
      const req    = await ledger.createMintRequest({ userId: 'u-fail', tokenId: 99n, amount: 1n, activityId: 'a-fail' });
      const result = await issuer.issueSingleWithRetry({ to: '0xWF', tokenId: req.tokenId, amount: req.amount, requestId: req.id, maxRetries: 5 });
      return { ledger, vasp, dlq, req, result };
    }

    it('result.success = false', async () => {
      const { result } = await makeFailedSetup();
      expect(result.success).toBe(false);
    });

    it('총 호출 횟수: 6 (maxRetries+1)', async () => {
      const { vasp } = await makeFailedSetup();
      expect(vasp.getCallCount()).toBe(6);
    });

    it('원장 상태: FAILED', async () => {
      const { ledger, req } = await makeFailedSetup();
      expect((await ledger.get(req.id))?.status).toBe('FAILED');
    });

    it('DLQ 적재됨', async () => {
      const { dlq, req } = await makeFailedSetup();
      const item = await dlq.get(req.id);
      expect(item).not.toBeNull();
    });

    it('DLQ reason에 VASP_UNAVAILABLE 포함', async () => {
      const { dlq, req } = await makeFailedSetup();
      const item = await dlq.get(req.id);
      expect(item?.reason).toContain('VASP_UNAVAILABLE');
    });
  });

  describe('TODO: REORG 복구 — REORGED → 재채굴 → CONFIRMED', () => {
    it('Reorg 전 상태: CONFIRMED', async () => {
      const ledger = new MockLedgerService();
      const req = await ledger.createMintRequest({ userId: 'u-reorg', tokenId: 1004n, amount: 1n, activityId: 'a-reorg' });
      await ledger.updateStatus(req.id, 'SUBMITTED', { vaspTxId: 'vasp-tx-004' });
      await ledger.updateStatus(req.id, 'MINED');
      await ledger.updateStatus(req.id, 'FINALIZED');
      await ledger.updateStatus(req.id, 'CONFIRMED', { onChainTxHash: '0xOriginalTxHash' });
      expect((await ledger.get(req.id))?.status).toBe('CONFIRMED');
    });

    it('Reorg 발생 후 상태: REORGED', async () => {
      const ledger = new MockLedgerService();
      const req = await ledger.createMintRequest({ userId: 'u-reorg2', tokenId: 1005n, amount: 1n, activityId: 'a-reorg2' });
      await ledger.updateStatus(req.id, 'SUBMITTED');
      await ledger.updateStatus(req.id, 'MINED');
      await ledger.updateStatus(req.id, 'FINALIZED');
      await ledger.updateStatus(req.id, 'CONFIRMED', { onChainTxHash: '0xOriginalHash' });
      await ledger.updateStatus(req.id, 'REORGED');
      expect((await ledger.get(req.id))?.status).toBe('REORGED');
    });

    it('재채굴 후 새 TX 해시로 CONFIRMED', async () => {
      const ledger = new MockLedgerService();
      const req = await ledger.createMintRequest({ userId: 'u-reorg3', tokenId: 1006n, amount: 1n, activityId: 'a-reorg3' });
      await ledger.updateStatus(req.id, 'SUBMITTED');
      await ledger.updateStatus(req.id, 'MINED');
      await ledger.updateStatus(req.id, 'CONFIRMED', { onChainTxHash: '0xOriginalHash' });
      await ledger.updateStatus(req.id, 'REORGED');
      await ledger.updateStatus(req.id, 'MINED');
      await ledger.updateStatus(req.id, 'FINALIZED');
      await ledger.updateStatus(req.id, 'CONFIRMED', { onChainTxHash: '0xNewTxHash789' });
      const final = await ledger.get(req.id);
      expect(final?.status).toBe('CONFIRMED');
      expect(final?.onChainTxHash).toBe('0xNewTxHash789');
    });
  });

  describe('TODO: Consumer 크래시 멱등성 — 중복 없이 재처리', () => {
    it('XAUTOCLAIM: 미ACK 메시지 1개 재할당', () => {
      const stream = new MockRedisStream();
      stream.publish('evt-100');
      stream.receive(1);
      const reclaimed = stream.xautoclaim();
      expect(reclaimed).toHaveLength(1);
    });

    it('재할당 메시지: evt-100', () => {
      const stream = new MockRedisStream();
      stream.publish('evt-100');
      stream.receive(1);
      const reclaimed = stream.xautoclaim();
      expect(reclaimed[0]?.eventId).toBe('evt-100');
    });

    it('동일 이벤트 2번 처리 → 원장 1회만 업데이트 (멱등성)', async () => {
      const ledger = new MockLedgerService();
      const req    = await ledger.createMintRequest({ userId: 'u-idem', tokenId: 5100n, amount: 1n, activityId: 'evt-idem' });
      let updateCount = 0;

      const first  = await ledger.confirmIfNotAlready(req.id, '0xTx100a');
      if (first) updateCount++;

      const second = await ledger.confirmIfNotAlready(req.id, '0xTx100b');
      if (second) updateCount++;

      expect(updateCount).toBe(1);
    });

    it('첫 번째 확인: true 반환', async () => {
      const ledger = new MockLedgerService();
      const req    = await ledger.createMintRequest({ userId: 'u-idem2', tokenId: 5101n, amount: 1n, activityId: 'evt-idem2' });
      const first  = await ledger.confirmIfNotAlready(req.id, '0xTx');
      expect(first).toBe(true);
    });

    it('두 번째 확인(이미 CONFIRMED): false 반환', async () => {
      const ledger = new MockLedgerService();
      const req    = await ledger.createMintRequest({ userId: 'u-idem3', tokenId: 5102n, amount: 1n, activityId: 'evt-idem3' });
      await ledger.confirmIfNotAlready(req.id, '0xTx1');
      const second = await ledger.confirmIfNotAlready(req.id, '0xTx2');
      expect(second).toBe(false);
    });

    it('evt-100 ACK 후 PEL 크기: 0', () => {
      const stream = new MockRedisStream();
      stream.publish('evt-100');
      const [msg] = stream.receive(1);
      stream.ack(msg.id);
      expect(stream.pendingCount()).toBe(0);
    });

    it('크래시 전 PEL 크기: 1 (미ACK)', () => {
      const stream = new MockRedisStream();
      stream.publish('evt-crash');
      stream.receive(1); // ACK 없이 receive만
      expect(stream.pendingCount()).toBe(1);
    });
  });

  describe('TODO: 1-of-3 차단 / 2-of-3 성공', () => {
    const SIGNERS = ['0xSignerA', '0xSignerB', '0xSignerC'];

    it('1-of-3 단독 실행 → GS020 에러', () => {
      const safe = new SimpleSafe(SIGNERS, 2);
      expect(() => safe.execTransaction([{ signer: '0xSignerA', sig: '0xsig_a' }])).toThrow(/GS020/);
    });

    it('0-of-3 → GS020 에러', () => {
      const safe = new SimpleSafe(SIGNERS, 2);
      expect(() => safe.execTransaction([])).toThrow(/GS020/);
    });

    it('2-of-3 서명 → execTransaction txHash 반환', () => {
      const safe = new SimpleSafe(SIGNERS, 2);
      const result = safe.execTransaction([
        { signer: '0xSignerA', sig: '0xsig_a' },
        { signer: '0xSignerB', sig: '0xsig_b' },
      ]);
      expect(result.txHash).toMatch(/^0x/);
    });

    it('비소유자 서명은 유효 서명으로 카운트 안 됨', () => {
      const safe = new SimpleSafe(SIGNERS, 2);
      expect(() => safe.execTransaction([
        { signer: '0xNotOwner', sig: '0xsig_x' },
        { signer: '0xAlsoNotOwner', sig: '0xsig_y' },
      ])).toThrow(/GS020/);
    });
  });
});
