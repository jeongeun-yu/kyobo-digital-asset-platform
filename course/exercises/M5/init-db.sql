-- M5 실습용 스키마 — 교육 환경 전용 (운영 DB와 무관)

CREATE TABLE IF NOT EXISTS user_wallet_mapping (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     VARCHAR(64)  NOT NULL UNIQUE,
  wallet_addr VARCHAR(42)  NOT NULL,
  vasp_type   VARCHAR(16)  NOT NULL CHECK (vasp_type IN ('EXTERNAL', 'KYOBO')),
  verified    BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_mapping_user_id ON user_wallet_mapping(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_mapping_addr    ON user_wallet_mapping(wallet_addr);

COMMENT ON TABLE user_wallet_mapping IS 'M5 실습: userId ↔ walletAddr 매핑 (S27)';

-- ── S28: 발행 정책 ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS issuance_policies (
  id         BIGSERIAL    PRIMARY KEY,
  event_type VARCHAR(64)  NOT NULL UNIQUE,
  token_id   NUMERIC      NOT NULL,
  amount     NUMERIC      NOT NULL DEFAULT 1,
  valid_from TIMESTAMPTZ,
  valid_to   TIMESTAMPTZ,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issuance_policies_event_type ON issuance_policies(event_type);

COMMENT ON TABLE issuance_policies IS 'M5 실습: 이벤트 타입별 NFT 발행 정책 (S28~S29)';

-- ── S29: 발행 요청 상태머신 ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS issuance_requests (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     VARCHAR(64)  NOT NULL,
  event_type  VARCHAR(64)  NOT NULL,
  token_id    NUMERIC      NOT NULL,
  amount      NUMERIC      NOT NULL DEFAULT 1,
  wallet_addr VARCHAR(42),
  status      VARCHAR(16)  NOT NULL CHECK (status IN ('REQUESTED','SUBMITTED','CONFIRMED','FAILED')),
  tx_hash     VARCHAR(66),
  fail_reason TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issuance_requests_pending
  ON issuance_requests(user_id, event_type, token_id)
  WHERE status IN ('REQUESTED', 'SUBMITTED');

COMMENT ON TABLE issuance_requests IS 'M5 실습: NFT 발행 요청 상태머신 — REQUESTED→SUBMITTED→CONFIRMED/FAILED (S29)';
