-- 운영 원장 스키마 (Node.js issuer-service 소유, 내부망)
-- 임시/기술적 데이터: 블록체인 트랜잭션 in-flight 상태

-- 발행 요청 상태머신 (PENDING → SUBMITTED → MINED → FINALIZED → CONFIRMED | FAILED | REORGED)
CREATE TABLE IF NOT EXISTS mint_requests (
  id           BIGSERIAL PRIMARY KEY,
  request_id   UUID NOT NULL UNIQUE,
  user_id      VARCHAR(64) NOT NULL,
  policy_id    VARCHAR(64) NOT NULL,
  status       VARCHAR(16) NOT NULL
               CHECK (status IN ('PENDING','SUBMITTED','MINED','FINALIZED','CONFIRMED','FAILED','REORGED')),
  tx_hash      VARCHAR(66),
  token_id     BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_msg    TEXT,
  expires_at   TIMESTAMPTZ GENERATED ALWAYS AS (created_at + INTERVAL '30 days') STORED
);

CREATE INDEX IF NOT EXISTS idx_mint_requests_user_id ON mint_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_mint_requests_status ON mint_requests(status);

-- 온체인 이벤트 멱등성 테이블 (중복 처리 방지)
CREATE TABLE IF NOT EXISTS processed_events (
  id           BIGSERIAL PRIMARY KEY,
  tx_hash      VARCHAR(66) NOT NULL,
  log_index    INT NOT NULL,
  event_name   VARCHAR(64) NOT NULL,
  block_number BIGINT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload      JSONB NOT NULL,
  UNIQUE(tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_processed_events_block ON processed_events(block_number);

COMMENT ON TABLE mint_requests IS '운영 원장 (issuer-service 소유): NFT 발행 요청 상태 추적. 30일 후 자동 만료.';
COMMENT ON TABLE processed_events IS '운영 원장 (issuer-service 소유): 온체인 이벤트 중복 방지. 90일 보존.';

-- Outbox 이벤트 테이블 (Phase 3: DB-외부 시스템 원자성 보장)
-- DB 트랜잭션과 외부 API 호출(VASP, 원장 업데이트) 사이의 불일치 방지
CREATE TABLE IF NOT EXISTS outbox_events (
  id            UUID         PRIMARY KEY,
  type          VARCHAR(64)  NOT NULL
                CHECK (type IN ('VASP_SUBMIT_MINT','VASP_SUBMIT_BURN','LEDGER_UPDATE_HOLDING','AUDIT_LOG_EMIT')),
  payload       JSONB        NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PROCESSING','PROCESSED','DEAD')),
  attempt_count INT          NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- PENDING 이벤트만 인덱싱 (OutboxWorker 폴링 최적화)
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events(status, next_retry_at)
  WHERE status = 'PENDING';

COMMENT ON TABLE outbox_events IS '운영 원장 (issuer-service 소유): Outbox 패턴 — DB-외부 시스템 원자성 보장. PENDING→PROCESSING→PROCESSED|DEAD. 5회 재시도 후 DEAD.';
