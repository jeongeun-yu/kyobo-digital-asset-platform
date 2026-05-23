-- ── issuance_policies (issuer-service) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS issuance_policies (
  id         BIGSERIAL    PRIMARY KEY,
  event_type VARCHAR(64)  NOT NULL UNIQUE,
  token_id   NUMERIC      NOT NULL,
  amount     NUMERIC      NOT NULL DEFAULT 1,
  valid_from TIMESTAMPTZ,
  valid_to   TIMESTAMPTZ,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── issuance_requests (issuer-service) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS issuance_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     VARCHAR(64) NOT NULL,
  event_type  VARCHAR(64) NOT NULL,
  token_id    NUMERIC     NOT NULL,
  amount      NUMERIC     NOT NULL DEFAULT 1,
  wallet_addr VARCHAR(42),
  status      VARCHAR(16) NOT NULL CHECK (status IN ('REQUESTED','SUBMITTED','CONFIRMED','FAILED')),
  tx_hash     VARCHAR(66),
  fail_reason TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── mint_requests (core-banking / LedgerService) ────────────────────────────
CREATE TABLE IF NOT EXISTS mint_requests (
  id          UUID        PRIMARY KEY,
  user_id     TEXT        NOT NULL,
  policy_id   TEXT        NOT NULL,
  status      TEXT        NOT NULL,
  tx_hash     TEXT,
  token_id    NUMERIC,
  error_msg   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mint_requests_tx_hash
  ON mint_requests(tx_hash) WHERE tx_hash IS NOT NULL;

-- ── tx_mint_requests (vasp / PgTxRepository) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tx_mint_requests (
  id              UUID        PRIMARY KEY,
  user_id         TEXT        NOT NULL,
  token_id        NUMERIC     NOT NULL,
  amount          NUMERIC     NOT NULL,
  status          TEXT        NOT NULL,
  tx_hash         TEXT,
  block_number    INTEGER,
  retry_count     INTEGER     NOT NULL DEFAULT 0,
  gas_price_gwei  NUMERIC,
  fail_reason     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tx_mint_requests_status
  ON tx_mint_requests(status);

CREATE INDEX IF NOT EXISTS idx_tx_mint_requests_pending
  ON tx_mint_requests(created_at) WHERE status = 'PENDING';

-- ── user_wallet_mapping (issuer-service / WalletMappingService) ───────────────
CREATE TABLE IF NOT EXISTS user_wallet_mapping (
  id          SERIAL      PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL UNIQUE,
  wallet_addr VARCHAR(42) NOT NULL,
  vasp_type   VARCHAR(16) NOT NULL DEFAULT 'ANVIL',
  verified    BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_mapping_addr
  ON user_wallet_mapping(wallet_addr);

-- ── processed_events (core-banking / LedgerService) ──────────────────────────
CREATE TABLE IF NOT EXISTS processed_events (
  id           SERIAL      PRIMARY KEY,
  tx_hash      VARCHAR(66) NOT NULL,
  log_index    INTEGER     NOT NULL,
  event_name   VARCHAR(64) NOT NULL,
  block_number NUMERIC     NOT NULL,
  payload      JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_processed_events_tx_hash
  ON processed_events(tx_hash);

-- ── outbox_events (vasp / OutboxWorker) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbox_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type          VARCHAR(64) NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}',
  status        VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  attempt_count INT         NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events(status, next_retry_at) WHERE status = 'PENDING';

-- ── user_nft_holdings (Java internal-ledger / InternalLedgerService) ──────────
-- nft_holding_seq: NftHolding 엔티티 @SequenceGenerator(sequenceName="nft_holding_seq") 대응
CREATE SEQUENCE IF NOT EXISTS nft_holding_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS user_nft_holdings (
  id            BIGINT      PRIMARY KEY DEFAULT nextval('nft_holding_seq'),
  user_id       VARCHAR(64) NOT NULL,
  token_id      BIGINT      NOT NULL,
  contract_addr VARCHAR(42) NOT NULL,
  chain_id      INT         NOT NULL,
  amount        BIGINT      NOT NULL DEFAULT 1,
  acquired_at   TIMESTAMPTZ NOT NULL,
  released_at   TIMESTAMPTZ,
  on_chain_tx   VARCHAR(66) NOT NULL,
  UNIQUE (user_id, token_id, contract_addr, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_nft_holdings_user
  ON user_nft_holdings(user_id);

-- ── audit_log (Java internal-ledger / AuditLogService, append-only) ───────────
-- audit_log_seq: AuditLogEntry 엔티티 @SequenceGenerator(sequenceName="audit_log_seq") 대응
CREATE SEQUENCE IF NOT EXISTS audit_log_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGINT       PRIMARY KEY DEFAULT nextval('audit_log_seq'),
  event_time    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actor         VARCHAR(64)  NOT NULL,
  action        VARCHAR(64)  NOT NULL,
  resource_type VARCHAR(32)  NOT NULL,
  resource_id   VARCHAR(128) NOT NULL,
  before_state  JSONB,
  after_state   JSONB        NOT NULL,
  prev_checksum VARCHAR(64),
  checksum      VARCHAR(64)  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_resource
  ON audit_log(resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_time
  ON audit_log(event_time);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_insert_only ON audit_log FOR INSERT WITH CHECK (true);
