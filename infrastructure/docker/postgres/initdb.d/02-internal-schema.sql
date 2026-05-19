-- 내부망 영구 원장 스키마 (Java internal-ledger 소유)
-- 규제 데이터: NFT 보유 현황, 감사 로그 (Oracle에서도 사용 가능한 SQL)

-- 사용자 NFT 보유 현황 (온체인에서 파생, 영구 보존)
CREATE TABLE IF NOT EXISTS user_nft_holdings (
  id            BIGSERIAL PRIMARY KEY,
  user_id       VARCHAR(64) NOT NULL,
  token_id      BIGINT NOT NULL,
  contract_addr VARCHAR(42) NOT NULL,
  chain_id      INT NOT NULL,
  amount        BIGINT NOT NULL DEFAULT 1,
  acquired_at   TIMESTAMPTZ NOT NULL,
  released_at   TIMESTAMPTZ,
  on_chain_tx   VARCHAR(66) NOT NULL,
  UNIQUE(user_id, token_id, contract_addr, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_nft_holdings_user ON user_nft_holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_nft_holdings_active ON user_nft_holdings(user_id) WHERE released_at IS NULL;

-- 감사 로그 (append-only — INSERT만 허용)
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  event_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor         VARCHAR(64) NOT NULL,
  action        VARCHAR(64) NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  resource_id   VARCHAR(128) NOT NULL,
  before_state  JSONB,
  after_state   JSONB NOT NULL,
  checksum      VARCHAR(64) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(event_time);

-- 감사 로그 INSERT 전용 강제 (PostgreSQL Row Level Security)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_insert_only ON audit_log FOR INSERT WITH CHECK (true);
-- UPDATE/DELETE 정책 없음 = 불가능

COMMENT ON TABLE user_nft_holdings IS '내부망 영구 원장: 사용자 NFT 보유 현황. 가상자산이용자보호법 §15 5년 보존.';
COMMENT ON TABLE audit_log IS '내부망 감사 로그: append-only. ISMS-P + 전자금융감독규정 §34. checksum으로 무결성 보장.';
