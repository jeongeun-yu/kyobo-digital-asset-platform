/**
 * S29 실습 — IssuerService · issueOne() 6단계 파이프라인
 *
 * 사전 준비:
 *   npm run exercise:s27:db:up      ← S27과 같은 DB 사용 (issuance_policies 테이블 포함)
 *
 * 실행:
 *   npm run exercise:s29            → 전체 실행
 *   npm run exercise:s29:1          → [1] 정상 발행 — REQUESTED → SUBMITTED 흐름
 *   npm run exercise:s29:2          → [2] 조건 미충족 → eligible=false → 레코드 미생성
 *   npm run exercise:s29:3          → [3] 정책 없음 → NoPolicyError → 레코드 미생성
 *   npm run exercise:s29:4          → [4] 지갑 조회 실패 → REQUESTED → FAILED
 *   npm run exercise:s29:5          → [5] VASP 위탁 실패 → FAILED
 *   npm run exercise:s29:6          → [6] 멱등성 — 동일 이벤트 재전송 → 기존 requestId 반환
 *   npm run exercise:s29:7          → [7] Webhook — SUBMITTED → CONFIRMED · 상태 전이 불변
 */

import { randomUUID } from 'crypto';

// ── 타입 정의 ─────────────────────────────────────────────────────────────────

type IssuanceStatus = 'REQUESTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

interface IssuanceRequest {
  id:         string;
  userId:     string;
  eventType:  string;
  tokenId:    bigint;
  amount:     bigint;
  walletAddr: string | null;
  status:     IssuanceStatus;
  txHash:     string | null;
  failReason: string | null;
  createdAt:  Date;
  updatedAt:  Date;
}

interface IssuancePolicy {
  eventType: string;
  tokenId:   bigint;
  amount:    bigint;
}

interface ConditionResult {
  eligible: boolean;
  reason?:  string;
}

interface WalletProvisionResult {
  walletAddress: string;
}

// ── 에러 클래스 ───────────────────────────────────────────────────────────────

export class NoPolicyError extends Error {
  constructor(eventType: string) {
    super(`발행 정책 없음: ${eventType}`);
    this.name = 'NoPolicyError';
  }
}

// ── IssuanceRequestRepository — in-memory ────────────────────────────────────
//
// 운영에서는 PostgreSQL. 실습에서는 상태 전이 로직에 집중하기 위해 in-memory 사용.

export class InMemoryIssuanceRepo {
  private readonly store = new Map<string, IssuanceRequest>();

  async create(params: Omit<IssuanceRequest, 'id' | 'createdAt' | 'updatedAt'>): Promise<IssuanceRequest> {
    const req: IssuanceRequest = {
      ...params,
      id:        randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.store.set(req.id, req);
    console.log(`  [REPO] create  id=${req.id}  status=REQUESTED  userId=${req.userId}  eventType=${req.eventType}`);
    return { ...req };
  }

  async setWalletAddr(id: string, walletAddr: string): Promise<void> {
    const req = this.store.get(id);
    if (!req) throw new Error(`IssuanceRequest not found: ${id}`);
    req.walletAddr = walletAddr;
    req.updatedAt  = new Date();
    console.log(`  [REPO] setWalletAddr  id=${id}  walletAddr=${walletAddr}`);
  }

  async updateStatus(
    id:        string,
    newStatus: IssuanceStatus,
    extra?:    { txHash?: string; failReason?: string },
  ): Promise<void> {
    const req = this.store.get(id);
    if (!req) throw new Error(`IssuanceRequest not found: ${id}`);

    // 상태 전이 불변 조건 — CONFIRMED·FAILED는 종단 상태
    if (req.status === 'CONFIRMED' || req.status === 'FAILED') {
      throw new Error(`상태 전이 불가: ${req.status} → ${newStatus}`);
    }

    const prev = req.status;
    req.status    = newStatus;
    req.updatedAt = new Date();
    if (extra?.txHash)     req.txHash     = extra.txHash;
    if (extra?.failReason) req.failReason = extra.failReason;
    console.log(`  [REPO] updateStatus  id=${id}  ${prev} → ${newStatus}${extra?.txHash ? `  txHash=${extra.txHash}` : ''}${extra?.failReason ? `  failReason=${extra.failReason}` : ''}`);
  }

  async findPending(userId: string, eventType: string, tokenId: bigint): Promise<IssuanceRequest | null> {
    for (const req of this.store.values()) {
      if (
        req.userId    === userId &&
        req.eventType === eventType &&
        req.tokenId   === tokenId &&
        (req.status === 'REQUESTED' || req.status === 'SUBMITTED')
      ) {
        console.log(`  [REPO] findPending → 기존 요청 발견  id=${req.id}  status=${req.status}`);
        return { ...req };
      }
    }
    console.log(`  [REPO] findPending → 없음`);
    return null;
  }

  async findById(id: string): Promise<IssuanceRequest | null> {
    const req = this.store.get(id);
    return req ? { ...req } : null;
  }

  count(): number { return this.store.size; }
}

// ── IVaspIssuanceClient 인터페이스 ────────────────────────────────────────────

interface IVaspIssuanceClient {
  submitIssuance(params: {
    requestId:  string;
    walletAddr: string;
    tokenId:    bigint;
    amount:     bigint;
  }): Promise<void>;
}

// ── IssuerService — 핵심 오케스트레이터 ──────────────────────────────────────
//
// 6단계 파이프라인:
//   ① 발행 정책 조회   — policyService.getPolicy()
//   ② 조건 판단       — conditionService.evaluate()
//   ③ 멱등성 체크     — issuanceRepo.findPending()
//   ④ 발행 요청 생성  — issuanceRepo.create() → REQUESTED
//   ⑤ 지갑 조회      — walletProvisioning.provision()  (실패 → FAILED + throw)
//   ⑥ VASP 위탁      — vaspClient.submitIssuance()    → SUBMITTED  (실패 → FAILED + throw)
//
// CONFIRMED는 issueOne()에서 설정하지 않는다 → Webhook 핸들러가 처리

export class IssuerService {
  constructor(
    private readonly deps: {
      policyService:      { getPolicy(eventType: string): Promise<IssuancePolicy> };
      conditionService:   { evaluate(event: { userId: string; eventType: string; data: Record<string, unknown> }): Promise<ConditionResult> };
      issuanceRepo:       InMemoryIssuanceRepo;
      walletProvisioning: { provision(userId: string, vaspType: string): Promise<WalletProvisionResult> };
      vaspClient:         IVaspIssuanceClient;
    },
  ) {}

  async issueOne(event: {
    userId:    string;
    eventType: string;
    data:      Record<string, unknown>;
  }): Promise<{ requestId: string; eligible: boolean }> {
    const { userId, eventType, data } = event;

    // ① 발행 정책 조회 (NoPolicyError → 상위로 전파)
    console.log(`  [①] 발행 정책 조회  eventType=${eventType}`);
    const policy = await this.deps.policyService.getPolicy(eventType);

    // ② 조건 판단
    console.log(`  [②] 조건 판단  userId=${userId}`);
    const condition = await this.deps.conditionService.evaluate({ userId, eventType, data });
    if (!condition.eligible) {
      console.log(`  [②] eligible=false → 레코드 미생성, 즉시 반환  reason=${condition.reason}`);
      return { requestId: '', eligible: false };
    }

    // ③ 멱등성 체크 — 이미 진행 중인 요청이 있으면 새 요청 생성 안 함
    console.log(`  [③] 멱등성 체크`);
    const existing = await this.deps.issuanceRepo.findPending(userId, eventType, policy.tokenId);
    if (existing) {
      console.log(`  [③] 기존 요청 반환  requestId=${existing.id}`);
      return { requestId: existing.id, eligible: true };
    }

    // ④ 발행 요청 생성 (REQUESTED)
    console.log(`  [④] 발행 요청 생성 REQUESTED`);
    const req = await this.deps.issuanceRepo.create({
      userId,
      eventType,
      tokenId:    policy.tokenId,
      amount:     policy.amount,
      walletAddr: null,
      status:     'REQUESTED',
      txHash:     null,
      failReason: null,
    });

    // ⑤ 지갑 주소 조회 (실패 → FAILED + throw)
    console.log(`  [⑤] 지갑 주소 조회`);
    let walletAddr: string;
    try {
      const result = await this.deps.walletProvisioning.provision(userId, 'EXTERNAL');
      walletAddr   = result.walletAddress;
      await this.deps.issuanceRepo.setWalletAddr(req.id, walletAddr);
    } catch (err) {
      await this.deps.issuanceRepo.updateStatus(req.id, 'FAILED', { failReason: (err as Error).message });
      throw err;
    }

    // ⑥ VASP 위탁 발행 (실패 → FAILED + throw)
    console.log(`  [⑥] VASP 위탁 발행  walletAddr=${walletAddr}`);
    try {
      await this.deps.vaspClient.submitIssuance({
        requestId: req.id,
        walletAddr,
        tokenId:   policy.tokenId,
        amount:    policy.amount,
      });
      await this.deps.issuanceRepo.updateStatus(req.id, 'SUBMITTED');
    } catch (err) {
      await this.deps.issuanceRepo.updateStatus(req.id, 'FAILED', { failReason: (err as Error).message });
      throw err;
    }

    return { requestId: req.id, eligible: true };
  }

  // VASP Webhook 핸들러 — issueOne()과 분리된 별도 경로
  async handleVaspWebhook(payload: {
    requestId: string;
    txHash?:   string;
    status:    'confirmed' | 'failed';
    reason?:   string;
  }): Promise<void> {
    console.log(`  [WEBHOOK] requestId=${payload.requestId}  status=${payload.status}`);
    if (payload.status === 'confirmed') {
      await this.deps.issuanceRepo.updateStatus(payload.requestId, 'CONFIRMED', { txHash: payload.txHash });
    } else {
      await this.deps.issuanceRepo.updateStatus(payload.requestId, 'FAILED', { failReason: payload.reason ?? 'VASP reported failure' });
    }
  }
}

// ── Mock 빌더 ─────────────────────────────────────────────────────────────────

const FIXED_TOKEN_ID = BigInt(0x01) << BigInt(64);
const FIXED_WALLET   = '0xWALLET000000000000000000000000000000001';

function makeDeps(overrides: {
  eligible?:       boolean;
  noPolicyFor?:    string;
  walletFail?:     boolean;
  vaspFail?:       boolean;
} = {}) {
  const vaspCalls: unknown[] = [];

  return {
    policyService: {
      async getPolicy(eventType: string) {
        if (overrides.noPolicyFor === eventType) throw new NoPolicyError(eventType);
        console.log(`  [POLICY] getPolicy(${eventType}) → tokenId=${FIXED_TOKEN_ID}`);
        return { eventType, tokenId: FIXED_TOKEN_ID, amount: 1n };
      },
    },
    conditionService: {
      async evaluate() {
        const result = { eligible: overrides.eligible ?? true };
        console.log(`  [CONDITION] evaluate → eligible=${result.eligible}`);
        return result;
      },
    },
    walletProvisioning: {
      async provision(userId: string) {
        if (overrides.walletFail) throw new Error(`WalletNotFoundError: ${userId}`);
        console.log(`  [WALLET] provision(${userId}) → ${FIXED_WALLET}`);
        return { walletAddress: FIXED_WALLET };
      },
    },
    vaspClient: {
      async submitIssuance(params: unknown) {
        vaspCalls.push(params);
        if (overrides.vaspFail) throw new Error('VASP connection timeout');
        console.log(`  [VASP] submitIssuance 호출`);
      },
    } as IVaspIssuanceClient,
    vaspCalls,
  };
}

// ── 섹션 함수 ─────────────────────────────────────────────────────────────────

async function section1(): Promise<void> {
  console.log('[1] 정상 발행 — REQUESTED → SUBMITTED 흐름');
  const repo = new InMemoryIssuanceRepo();
  const deps = makeDeps();
  const svc  = new IssuerService({ ...deps, issuanceRepo: repo });

  const result = await svc.issueOne({ userId: 'K-29001', eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } });
  console.log('  issueOne 결과:', result);

  const req = await repo.findById(result.requestId);
  console.log('  최종 상태:', req?.status, '← SUBMITTED');
  console.log('  walletAddr:', req?.walletAddr);
  console.log('  VASP 호출 횟수:', deps.vaspCalls.length, '← 1');
}

async function section2(): Promise<void> {
  console.log('[2] 조건 미충족 → eligible=false → 레코드 미생성');
  const repo = new InMemoryIssuanceRepo();
  const deps = makeDeps({ eligible: false });
  const svc  = new IssuerService({ ...deps, issuanceRepo: repo });

  const result = await svc.issueOne({ userId: 'K-29002', eventType: 'WALK_GOAL_MET', data: { steps: 100 } });
  console.log('  issueOne 결과:', result);
  console.log('  eligible:', result.eligible, '← false');
  console.log('  requestId:', result.requestId, '← 빈 문자열');
  console.log('  DB 레코드 수:', repo.count(), '← 0 (레코드 미생성)');
}

async function section3(): Promise<void> {
  console.log('[3] 정책 없음 → NoPolicyError → 레코드 미생성');
  const repo = new InMemoryIssuanceRepo();
  const deps = makeDeps({ noPolicyFor: 'UNKNOWN_EVENT' });
  const svc  = new IssuerService({ ...deps, issuanceRepo: repo });

  try {
    await svc.issueOne({ userId: 'K-29003', eventType: 'UNKNOWN_EVENT', data: {} });
  } catch (err) {
    console.log('  에러:', (err as Error).constructor.name, (err as Error).message);
  }
  console.log('  DB 레코드 수:', repo.count(), '← 0 (레코드 미생성)');
}

async function section4(): Promise<void> {
  console.log('[4] 지갑 조회 실패 → REQUESTED → FAILED 상태 전이');
  const repo = new InMemoryIssuanceRepo();
  const deps = makeDeps({ walletFail: true });
  const svc  = new IssuerService({ ...deps, issuanceRepo: repo });

  let requestId = '';
  try {
    const r = await svc.issueOne({ userId: 'K-29004', eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } });
    requestId = r.requestId;
  } catch (err) {
    console.log('  에러:', (err as Error).message);
  }

  // 마지막으로 생성된 요청 찾기
  const allEntries = [...(repo as any).store.values()] as IssuanceRequest[];
  const req = allEntries[0];
  console.log('  DB 상태:', req?.status, '← FAILED');
  console.log('  failReason:', req?.failReason);
  console.log('  walletAddr:', req?.walletAddr, '← null (지갑 조회 실패)');
}

async function section5(): Promise<void> {
  console.log('[5] VASP 위탁 실패 → FAILED');
  const repo = new InMemoryIssuanceRepo();
  const deps = makeDeps({ vaspFail: true });
  const svc  = new IssuerService({ ...deps, issuanceRepo: repo });

  try {
    await svc.issueOne({ userId: 'K-29005', eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } });
  } catch (err) {
    console.log('  에러:', (err as Error).message);
  }

  const allEntries = [...(repo as any).store.values()] as IssuanceRequest[];
  const req = allEntries[0];
  console.log('  DB 상태:', req?.status, '← FAILED');
  console.log('  failReason:', req?.failReason);
  console.log('  walletAddr:', req?.walletAddr, '← 지갑 조회는 성공 (VASP 단계에서 실패)');
}

async function section6(): Promise<void> {
  console.log('[6] 멱등성 — 동일 이벤트 재전송 → 기존 requestId 반환');
  const repo = new InMemoryIssuanceRepo();
  const deps = makeDeps();
  const svc  = new IssuerService({ ...deps, issuanceRepo: repo });

  const r1 = await svc.issueOne({ userId: 'K-29006', eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } });
  console.log('  1차 발행  requestId:', r1.requestId);

  const r2 = await svc.issueOne({ userId: 'K-29006', eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } });
  console.log('  2차 발행  requestId:', r2.requestId);

  console.log('  requestId 동일:', r1.requestId === r2.requestId, '← true (기존 요청 반환)');
  console.log('  DB 레코드 수:', repo.count(), '← 1 (중복 생성 없음)');
  console.log('  VASP 호출 횟수:', deps.vaspCalls.length, '← 1 (2차에 VASP 재호출 없음)');
}

async function section7(): Promise<void> {
  console.log('[7] Webhook — SUBMITTED → CONFIRMED · 상태 전이 불변');
  const repo = new InMemoryIssuanceRepo();
  const deps = makeDeps();
  const svc  = new IssuerService({ ...deps, issuanceRepo: repo });

  const { requestId } = await svc.issueOne({ userId: 'K-29007', eventType: 'WALK_GOAL_MET', data: { steps: 12_000 } });
  console.log('  issueOne 완료  status: SUBMITTED');

  // VASP Webhook → CONFIRMED
  await svc.handleVaspWebhook({ requestId, txHash: '0xdeadbeef', status: 'confirmed' });
  const confirmed = await repo.findById(requestId);
  console.log('  Webhook 후 상태:', confirmed?.status, '← CONFIRMED');
  console.log('  txHash:', confirmed?.txHash);

  // 종단 상태 → 추가 전이 불가
  try {
    await svc.handleVaspWebhook({ requestId, status: 'failed', reason: 'retry' });
  } catch (err) {
    console.log('  CONFIRMED → FAILED 시도:', (err as Error).message, '← 불변 조건 동작');
  }
}

// ── 진입점 ───────────────────────────────────────────────────────────────────

const SECTIONS: Record<string, () => Promise<void>> = {
  '1': section1,
  '2': section2,
  '3': section3,
  '4': section4,
  '5': section5,
  '6': section6,
  '7': section7,
};

(async () => {
  const arg = process.argv[2];

  if (arg && SECTIONS[arg]) {
    console.log(`=== S29: 섹션 [${arg}] ===\n`);
    await SECTIONS[arg]!();
  } else {
    console.log('=== S29: IssuerService + issueOne() 6단계 파이프라인 — 전체 실행 ===\n');
    for (const fn of Object.values(SECTIONS)) {
      await fn();
      console.log();
    }
  }

  console.log('\nS29 완료');
})();
