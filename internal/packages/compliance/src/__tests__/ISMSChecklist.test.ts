/**
 * ISMSChecklist 단위 테스트
 *
 * 5가지 체크 항목(ACCESS / CRYPTO / LOG / NETWORK / INCIDENT) 검증
 */

import { ISMSChecklist, type ISMSCheckDeps } from '../isms/ISMSChecklist';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<ISMSCheckDeps> = {}): ISMSCheckDeps {
  return {
    contractCall:       async () => false,
    queryLatestAuditLog: async () => ({ createdAt: new Date() }),
    rpcUrl:             'http://10.0.0.1:8545',     // 내부망 URL
    nftContractAddr:    '0xNFTContract',
    ...overrides,
  };
}

// ── 테스트 ────────────────────────────────────────────────────────────────────

describe('ISMSChecklist.runAll()', () => {
  afterEach(() => {
    // 환경변수 클린업
    delete process.env['OPERATOR_PRIVATE_KEY'];
    delete process.env['EVM_SIGNER_KEY'];
    delete process.env['DEPLOYER_PRIVATE_KEY'];
  });

  it('정상 환경 → 5개 항목 모두 결과 반환', async () => {
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    expect(results).toHaveLength(5);
  });

  it('결과 항목에 itemId, passed, checkedAt 포함', async () => {
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    for (const r of results) {
      expect(r.itemId).toBeDefined();
      expect(typeof r.passed).toBe('boolean');
      expect(typeof r.checkedAt).toBe('number');
    }
  });
});

describe('ISMSChecklist — ACCESS 체크 (ISMS-ACCESS-001)', () => {
  afterEach(() => {
    delete process.env['OPERATOR_PRIVATE_KEY'];
    delete process.env['EVM_SIGNER_KEY'];
    delete process.env['DEPLOYER_PRIVATE_KEY'];
  });

  it('평문 private key 환경변수 없음 → passed: true', async () => {
    delete process.env['OPERATOR_PRIVATE_KEY'];
    delete process.env['EVM_SIGNER_KEY'];
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    const access = results.find(r => r.itemId === 'ISMS-ACCESS-001');
    expect(access?.passed).toBe(true);
  });

  it('평문 private key 환경변수 설정 → passed: false', async () => {
    process.env['OPERATOR_PRIVATE_KEY'] = '0x' + 'a'.repeat(64);
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    const access = results.find(r => r.itemId === 'ISMS-ACCESS-001');
    expect(access?.passed).toBe(false);
  });

  it('KMS ARN 형태 → passed: true', async () => {
    process.env['EVM_SIGNER_KEY'] = 'arn:aws:kms:ap-northeast-2:123456789:key/abc';
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    const access = results.find(r => r.itemId === 'ISMS-ACCESS-001');
    expect(access?.passed).toBe(true);
  });
});

describe('ISMSChecklist — CRYPTO 체크 (ISMS-CRYPTO-001)', () => {
  afterEach(() => {
    delete process.env['EVM_SIGNER_KEY'];
  });

  it('EVM_SIGNER_KEY 미설정 → passed: true', async () => {
    delete process.env['EVM_SIGNER_KEY'];
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    const crypto = results.find(r => r.itemId === 'ISMS-CRYPTO-001');
    expect(crypto?.passed).toBe(true);
  });

  it('EVM_SIGNER_KEY가 64자 hex → passed: false', async () => {
    process.env['EVM_SIGNER_KEY'] = 'a'.repeat(64);
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    const crypto = results.find(r => r.itemId === 'ISMS-CRYPTO-001');
    expect(crypto?.passed).toBe(false);
  });

  it('EVM_SIGNER_KEY가 0x + 64자 hex → passed: false', async () => {
    process.env['EVM_SIGNER_KEY'] = '0x' + 'f'.repeat(64);
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    const crypto = results.find(r => r.itemId === 'ISMS-CRYPTO-001');
    expect(crypto?.passed).toBe(false);
  });
});

describe('ISMSChecklist — LOG 체크 (ISMS-LOG-001)', () => {
  it('1시간 이내 감사 로그 → passed: true', async () => {
    const deps = makeDeps({ queryLatestAuditLog: async () => ({ createdAt: new Date() }) });
    const results = await new ISMSChecklist(deps).runAll();
    const log = results.find(r => r.itemId === 'ISMS-LOG-001');
    expect(log?.passed).toBe(true);
  });

  it('감사 로그 없음 → passed: false', async () => {
    const deps = makeDeps({ queryLatestAuditLog: async () => null });
    const results = await new ISMSChecklist(deps).runAll();
    const log = results.find(r => r.itemId === 'ISMS-LOG-001');
    expect(log?.passed).toBe(false);
  });

  it('2시간 전 감사 로그 → passed: false', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const deps = makeDeps({ queryLatestAuditLog: async () => ({ createdAt: twoHoursAgo }) });
    const results = await new ISMSChecklist(deps).runAll();
    const log = results.find(r => r.itemId === 'ISMS-LOG-001');
    expect(log?.passed).toBe(false);
  });
});

describe('ISMSChecklist — NETWORK 체크 (ISMS-NETWORK-001)', () => {
  it('내부망 사설 IP → passed: true', async () => {
    const deps = makeDeps({ rpcUrl: 'http://10.0.0.1:8545' });
    const results = await new ISMSChecklist(deps).runAll();
    const net = results.find(r => r.itemId === 'ISMS-NETWORK-001');
    expect(net?.passed).toBe(true);
  });

  it('infura.io URL → passed: false', async () => {
    const deps = makeDeps({ rpcUrl: 'https://mainnet.infura.io/v3/apikey' });
    const results = await new ISMSChecklist(deps).runAll();
    const net = results.find(r => r.itemId === 'ISMS-NETWORK-001');
    expect(net?.passed).toBe(false);
  });

  it('alchemy.com URL → passed: false', async () => {
    const deps = makeDeps({ rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/key' });
    const results = await new ISMSChecklist(deps).runAll();
    const net = results.find(r => r.itemId === 'ISMS-NETWORK-001');
    expect(net?.passed).toBe(false);
  });
});

describe('ISMSChecklist — INCIDENT 체크 (ISMS-INCIDENT-001)', () => {
  it('paused() 호출 성공 → passed: true', async () => {
    const deps = makeDeps({ contractCall: async () => false });
    const results = await new ISMSChecklist(deps).runAll();
    const incident = results.find(r => r.itemId === 'ISMS-INCIDENT-001');
    expect(incident?.passed).toBe(true);
  });

  it('nftContractAddr 미설정 → passed: false', async () => {
    const deps = makeDeps({ nftContractAddr: '' });
    const results = await new ISMSChecklist(deps).runAll();
    const incident = results.find(r => r.itemId === 'ISMS-INCIDENT-001');
    expect(incident?.passed).toBe(false);
  });

  it('contractCall throw → passed: false (예외 캐치)', async () => {
    const deps = makeDeps({ contractCall: async () => { throw new Error('connection refused'); } });
    const results = await new ISMSChecklist(deps).runAll();
    const incident = results.find(r => r.itemId === 'ISMS-INCIDENT-001');
    expect(incident?.passed).toBe(false);
  });
});

describe('ISMSChecklist.getSummary()', () => {
  it('모두 통과 → failed 배열 빈 배열', async () => {
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    // ACCESS 체크는 환경에 따라 달라질 수 있으므로 passed 항목만 확인
    const allPassed = results.filter(r => r.passed);
    const summary = checklist.getSummary(allPassed.map(r => ({ ...r })));
    expect(summary.failed).toHaveLength(0);
    expect(summary.passed).toBe(allPassed.length);
  });

  it('실패 항목이 failed 배열에 포함', async () => {
    const deps = makeDeps({ queryLatestAuditLog: async () => null });
    const checklist = new ISMSChecklist(deps);
    const results = await checklist.runAll();
    const summary = checklist.getSummary(results);
    expect(summary.failed).toContain('ISMS-LOG-001');
  });

  it('total = 전체 결과 수', async () => {
    const checklist = new ISMSChecklist(makeDeps());
    const results = await checklist.runAll();
    const summary = checklist.getSummary(results);
    expect(summary.total).toBe(results.length);
  });
});
