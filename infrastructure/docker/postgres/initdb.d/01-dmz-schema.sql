-- DMZ 운영 원장 스키마 (Node.js issuer-service 소유)
-- 임시/기술적 데이터: 블록체인 트랜잭션 in-flight 상태

-- 발행 요청 상태머신 (PENDING → SUBMITTED → CONFIRMED | FAILED | REORGED)
CREATE TABLE IF NOT EXISTS mint_requests (
  id           BIGSERIAL PRIMARY KEY,
  request_id   UUID NOT NULL UNIQUE,
  user_id      VARCHAR(64) NOT NULL,
  policy_id    VARCHAR(64) NOT NULL,
  status       VARCHAR(16) NOT NULL
               CHECK (status IN ('PENDING','SUBMITTED','CONFIRMED','FAILED','REORGED')),
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

COMMENT ON TABLE mint_requests IS 'DMZ 운영 원장: NFT 발행 요청 상태 추적. 30일 후 자동 만료.';
COMMENT ON TABLE processed_events IS 'DMZ 운영 원장: 온체인 이벤트 중복 방지. 90일 보존.';
