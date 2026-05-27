import type { Pool } from 'pg';

/**
 * IssuancePolicyService — NFT 발행 정책 조회 서비스
 *
 * 역할:
 *   issuance_policies 테이블에서 eventType별 발행 정책(tokenId·amount)을 조회한다.
 *   IssuerService는 이 서비스를 통해서만 정책에 접근한다 (DB 직접 접근 금지).
 *
 * DIP 적용:
 *   IssuancePolicyService는 IIssuancePolicyRepository(인터페이스)만 의존한다.
 *   운영: PgIssuancePolicyRepository (PostgreSQL)
 *   테스트: InMemoryIssuancePolicyRepository (Map 기반)
 *
 * SRP 분리:
 *   - IssuancePolicyService: "이 이벤트에 발행 가능한 정책이 있는가?" (정책 관문)
 *   - EventConditionService:  "이 사용자가 조건을 충족하는가?" (조건 관문)
 *   두 서비스는 서로를 모른다. IssuerService가 두 결과를 조합한다.
 */

// ── 도메인 타입 ───────────────────────────────────────────────────────────────

/**
 * 발행 정책 도메인 모델
 *
 * issuance_policies 테이블의 한 행을 표현한다.
 * tokenId는 DB NUMERIC → JS BigInt 변환 필수 (BIGINT는 string으로 수신).
 */
export interface IssuancePolicy {
  id:          number;
  eventType:   string;
  tokenId:     bigint;   // DB NUMERIC(78) → BigInt (uint256 범위 대응)
  amount:      bigint;
  validFrom:   Date | null;
  validTo:     Date | null;
  createdAt:   Date;
}

// ── 에러 ─────────────────────────────────────────────────────────────────────

/**
 * NoPolicyError
 *
 * getPolicy()에서 발행 가능한 정책이 없을 때 던진다.
 * 세 가지 케이스 모두 동일 에러로 통일한다:
 *   1. DB에 정책 없음
 *   2. valid_from 이전 또는 valid_to 이후 (기간 외)
 *
 * 호출자(IssuerService)는 세부 이유보다 "발행 가능한가"만 알면 된다.
 */
export class NoPolicyError extends Error {
  constructor(public readonly eventType: string) {
    super(`발행 정책 없음: ${eventType}`);
    this.name = 'NoPolicyError';
  }
}

// ── 리포지토리 인터페이스 (DIP 경계) ─────────────────────────────────────────

/**
 * IIssuancePolicyRepository
 *
 * IssuancePolicyService가 의존하는 유일한 데이터 접근 계약.
 * 구현체: PgIssuancePolicyRepository (운영) / InMemoryIssuancePolicyRepository (테스트)
 */
export interface IIssuancePolicyRepository {
  /** eventType으로 정책 단건 조회. 없으면 null. */
  findByEventType(eventType: string): Promise<IssuancePolicy | null>;
}

// ── 리포지토리 구현체: PostgreSQL ─────────────────────────────────────────────

/**
 * PgIssuancePolicyRepository
 *
 * issuance_policies 테이블 DDL (init-db.sql):
 *
 *   CREATE TABLE IF NOT EXISTS issuance_policies (
 *     id         BIGSERIAL    PRIMARY KEY,
 *     event_type VARCHAR(64)  NOT NULL UNIQUE,
 *     token_id   NUMERIC      NOT NULL,
 *     amount     NUMERIC      NOT NULL DEFAULT 1,
 *     valid_from TIMESTAMPTZ,
 *     valid_to   TIMESTAMPTZ,
 *     created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
 *   );
 *
 * token_id가 NUMERIC인 이유:
 *   ERC-1155 tokenId는 uint256 → 최대 2^256-1. BIGINT(64비트)로 부족.
 *   node-postgres는 NUMERIC을 string으로 반환하므로 BigInt()로 변환 필수.
 */
export class PgIssuancePolicyRepository implements IIssuancePolicyRepository {
  constructor(private readonly pool: Pool) {}

  async findByEventType(eventType: string): Promise<IssuancePolicy | null> {
    const res = await this.pool.query<{
      id: string;
      event_type: string;
      token_id: string;
      amount: string;
      valid_from: Date | null;
      valid_to: Date | null;
      created_at: Date;
    }>(
      `SELECT id, event_type, token_id, amount, valid_from, valid_to, created_at
       FROM   issuance_policies
       WHERE  event_type = $1`,
      [eventType],
    );

    if (!res.rowCount) return null;
    return this._toModel(res.rows[0]!);
  }

  private _toModel(row: {
    id: string;
    event_type: string;
    token_id: string;
    amount: string;
    valid_from: Date | null;
    valid_to: Date | null;
    created_at: Date;
  }): IssuancePolicy {
    return {
      id:        Number(row.id),
      eventType: row.event_type,
      tokenId:   BigInt(row.token_id),   // NUMERIC → BigInt (손실 없이)
      amount:    BigInt(row.amount),
      validFrom: row.valid_from,
      validTo:   row.valid_to,
      createdAt: row.created_at,
    };
  }
}

// ── 리포지토리 구현체: InMemory (테스트용) ────────────────────────────────────

/**
 * InMemoryIssuancePolicyRepository
 *
 * 단위 테스트에서 PgIssuancePolicyRepository 대신 주입한다.
 * DB 연결 없이 IssuancePolicyService 로직만 검증할 수 있다.
 */
export class InMemoryIssuancePolicyRepository implements IIssuancePolicyRepository {
  private readonly store = new Map<string, IssuancePolicy>();

  seed(policies: IssuancePolicy[]): this {
    for (const p of policies) this.store.set(p.eventType, p);
    return this;
  }

  async findByEventType(eventType: string): Promise<IssuancePolicy | null> {
    return this.store.get(eventType) ?? null;
  }
}

// ── 서비스 ───────────────────────────────────────────────────────────────────

/**
 * IssuancePolicyService
 *
 * getPolicy() — 발행 가능한 정책 반환. 없으면 NoPolicyError.
 *
 * 검증 순서:
 *   1. DB 조회 → 없으면 NoPolicyError
 *   2. valid_from / valid_to 기간 검증 → 기간 외이면 NoPolicyError
 *
 * tokenId 출처:
 *   정책 DB에서 온다. EventConditionService(Strategy)는 tokenId를 모른다.
 *   Strategy의 책임은 "조건 충족 여부(true/false)"이고,
 *   "어떤 NFT를 발행하는가(tokenId)"는 정책의 책임이다 (SRP).
 */
export class IssuancePolicyService {
  constructor(
    private readonly repo: IIssuancePolicyRepository,
  ) {}

  /**
   * 발행 가능한 정책 조회
   *
   * @throws {NoPolicyError} 정책이 없거나 유효 기간 외인 경우
   */
  async getPolicy(eventType: string): Promise<IssuancePolicy> {
    const policy = await this.repo.findByEventType(eventType);

    if (!policy) {
      throw new NoPolicyError(eventType);
    }

    const now = new Date();
    if (policy.validFrom && now < policy.validFrom) {
      throw new NoPolicyError(eventType);
    }
    if (policy.validTo && now > policy.validTo) {
      throw new NoPolicyError(eventType);
    }

    return policy;
  }
}
