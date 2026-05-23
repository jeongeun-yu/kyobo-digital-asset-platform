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
