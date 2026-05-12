/**
 * WhitelistAddressService 단위 테스트
 *
 * Phase 3 스텁이므로 상태 전이 테이블(WHITELIST_VALID_TRANSITIONS) 검증 +
 * 각 메서드의 Phase 3 stub 동작(throw) 확인
 */

import {
  WhitelistAddressService,
  WHITELIST_VALID_TRANSITIONS,
  type WhitelistStatus,
} from '../governance/WhitelistAddressService';

// ── 상태 전이 테이블 테스트 ───────────────────────────────────────────────────

describe('WHITELIST_VALID_TRANSITIONS', () => {
  it('REGISTERED → APPROVAL_PENDING 허용', () => {
    expect(WHITELIST_VALID_TRANSITIONS['REGISTERED']).toContain('APPROVAL_PENDING');
  });

  it('REGISTERED → REJECTED 허용', () => {
    expect(WHITELIST_VALID_TRANSITIONS['REGISTERED']).toContain('REJECTED');
  });

  it('APPROVAL_PENDING → HOLDING 허용', () => {
    expect(WHITELIST_VALID_TRANSITIONS['APPROVAL_PENDING']).toContain('HOLDING');
  });

  it('APPROVAL_PENDING → REJECTED 허용', () => {
    expect(WHITELIST_VALID_TRANSITIONS['APPROVAL_PENDING']).toContain('REJECTED');
  });

  it('HOLDING → ACTIVE 허용 (타이머 자동)', () => {
    expect(WHITELIST_VALID_TRANSITIONS['HOLDING']).toContain('ACTIVE');
  });

  it('HOLDING → REVOKED 허용', () => {
    expect(WHITELIST_VALID_TRANSITIONS['HOLDING']).toContain('REVOKED');
  });

  it('ACTIVE → REVOKED만 허용', () => {
    expect(WHITELIST_VALID_TRANSITIONS['ACTIVE']).toEqual(['REVOKED']);
  });

  it('ACTIVE → REGISTERED 불허 (역방향 금지)', () => {
    expect(WHITELIST_VALID_TRANSITIONS['ACTIVE']).not.toContain('REGISTERED');
  });

  describe('종단 상태', () => {
    const terminalStates: WhitelistStatus[] = ['REJECTED', 'REVOKED'];

    for (const state of terminalStates) {
      it(`${state} → 전이 없음(빈 배열)`, () => {
        expect(WHITELIST_VALID_TRANSITIONS[state]).toHaveLength(0);
      });
    }
  });

  it('테이블에 6가지 상태 모두 등록', () => {
    const expected: WhitelistStatus[] = [
      'REGISTERED', 'APPROVAL_PENDING', 'HOLDING', 'ACTIVE', 'REJECTED', 'REVOKED',
    ];
    for (const s of expected) {
      expect(WHITELIST_VALID_TRANSITIONS).toHaveProperty(s);
    }
  });
});

// ── WhitelistAddressService Phase 3 스텁 동작 검증 ───────────────────────────

describe('WhitelistAddressService (Phase 3 stubs)', () => {
  let svc: WhitelistAddressService;

  beforeEach(() => {
    svc = new WhitelistAddressService();
  });

  it('register() → Phase 3 Error throw', async () => {
    await expect(svc.register('u-001', '0xaddr', '31337', 'cold wallet'))
      .rejects.toThrow('Phase 3');
  });

  it('isActive() → Phase 3 Error throw', async () => {
    await expect(svc.isActive('0xaddr', '31337'))
      .rejects.toThrow('Phase 3');
  });

  it('activateMatured() → Phase 3 Error throw', async () => {
    await expect(svc.activateMatured())
      .rejects.toThrow('Phase 3');
  });

  it('revoke() → Phase 3 Error throw', async () => {
    await expect(svc.revoke('entry-001', 'security breach'))
      .rejects.toThrow('Phase 3');
  });
});
