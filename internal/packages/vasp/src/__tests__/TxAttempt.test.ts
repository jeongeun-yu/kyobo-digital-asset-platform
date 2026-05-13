/**
 * TxAttempt 상태 전이 테이블 단위 테스트
 *
 * ATTEMPT_VALID_TRANSITIONS 맵의 정확성 + 종단 상태 검증
 */

import {
  ATTEMPT_VALID_TRANSITIONS,
  type AttemptStatus,
} from '../tx/TxAttempt';

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('ATTEMPT_VALID_TRANSITIONS', () => {
  describe('정상 경로 (A0 → A6)', () => {
    it('A0_CREATED → A1_SIGNED 허용', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A0_CREATED']).toContain('A1_SIGNED');
    });

    it('A1_SIGNED → A2_SENT_TO_RPC 허용', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A1_SIGNED']).toContain('A2_SENT_TO_RPC');
    });

    it('A2_SENT_TO_RPC → A3_SEEN_IN_MEMPOOL 허용', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A2_SENT_TO_RPC']).toContain('A3_SEEN_IN_MEMPOOL');
    });

    it('A3_SEEN_IN_MEMPOOL → A4_INCLUDED 허용', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A3_SEEN_IN_MEMPOOL']).toContain('A4_INCLUDED');
    });

    it('A4_INCLUDED → A5_CONFIRMED 허용', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A4_INCLUDED']).toContain('A5_CONFIRMED');
    });

    it('A5_CONFIRMED → A6_FINALIZED 허용', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A5_CONFIRMED']).toContain('A6_FINALIZED');
    });
  });

  describe('비정상 경로', () => {
    it('A2_SENT_TO_RPC → DROPPED 허용 (mempool 제거)', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A2_SENT_TO_RPC']).toContain('DROPPED');
    });

    it('A3_SEEN_IN_MEMPOOL → REPLACED 허용 (gas bump)', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A3_SEEN_IN_MEMPOOL']).toContain('REPLACED');
    });

    it('A4_INCLUDED → REVERTED 허용 (EVM 실행 실패)', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A4_INCLUDED']).toContain('REVERTED');
    });

    it('A5_CONFIRMED → RPC_INCONSISTENT 허용', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A5_CONFIRMED']).toContain('RPC_INCONSISTENT');
    });
  });

  describe('종단 상태 (전이 불가)', () => {
    const terminalStates: AttemptStatus[] = [
      'A6_FINALIZED', 'FAILED', 'DROPPED', 'REPLACED', 'REVERTED', 'RPC_INCONSISTENT',
    ];

    for (const state of terminalStates) {
      it(`${state} → 전이 없음(빈 배열)`, () => {
        expect(ATTEMPT_VALID_TRANSITIONS[state]).toHaveLength(0);
      });
    }
  });

  describe('역방향 전이 불가', () => {
    it('A6_FINALIZED → A5_CONFIRMED 불허', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A6_FINALIZED']).not.toContain('A5_CONFIRMED');
    });

    it('A5_CONFIRMED → A4_INCLUDED 불허', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['A5_CONFIRMED']).not.toContain('A4_INCLUDED');
    });

    it('FAILED → A0_CREATED 불허', () => {
      expect(ATTEMPT_VALID_TRANSITIONS['FAILED']).not.toContain('A0_CREATED');
    });
  });

  describe('테이블 완전성', () => {
    it('모든 AttemptStatus가 전이 테이블에 등록됨', () => {
      const expected: AttemptStatus[] = [
        'A0_CREATED', 'A1_SIGNED', 'A2_SENT_TO_RPC', 'A3_SEEN_IN_MEMPOOL',
        'A4_INCLUDED', 'A5_CONFIRMED', 'A6_FINALIZED',
        'FAILED', 'DROPPED', 'REPLACED', 'REVERTED', 'RPC_INCONSISTENT',
      ];
      for (const status of expected) {
        expect(ATTEMPT_VALID_TRANSITIONS).toHaveProperty(status);
      }
    });

    it('FAILED는 어느 초기 상태에서든 전이 가능 (A0~A3)', () => {
      const initialStates: AttemptStatus[] = ['A0_CREATED', 'A1_SIGNED', 'A2_SENT_TO_RPC', 'A3_SEEN_IN_MEMPOOL'];
      for (const s of initialStates) {
        expect(ATTEMPT_VALID_TRANSITIONS[s]).toContain('FAILED');
      }
    });
  });
});
