-- =============================================================================
-- Phenotyping DB — full schema (consolidated from alembic migrations 001..010)
-- Target: PostgreSQL 14+
-- Connect as the database owner (e.g. `phenotyping`) before running.
--
-- NOTE: Prefer `alembic upgrade head` in production. This file is a flattened
-- snapshot for manual provisioning / inspection only. After running it, you
-- should manually stamp alembic to head:
--     alembic stamp head
-- =============================================================================

-- Required extension (uuid generation)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- user_account  (009)
-- =============================================================================
CREATE TABLE user_account (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email          VARCHAR(320) NOT NULL,
    name           VARCHAR(200),
    password_hash  TEXT         NOT NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX ix_user_account_email ON user_account (email);

-- =============================================================================
-- revoked_token  (009)
-- =============================================================================
CREATE TABLE revoked_token (
    jti         VARCHAR(64) PRIMARY KEY,
    user_id     UUID        NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_revoked_token_user_id    ON revoked_token (user_id);
CREATE INDEX ix_revoked_token_expires_at ON revoked_token (expires_at);

-- =============================================================================
-- analysis_batch  (001 + 003 name + 006 processing-state + 007 classes + 010 user_id)
-- =============================================================================
CREATE TABLE analysis_batch (
    id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at           TIMESTAMPTZ,
    status                 VARCHAR(20)  NOT NULL DEFAULT 'processing',
    organism_type          VARCHAR(20)  NOT NULL DEFAULT 'egg',
    mode                   VARCHAR(20)  NOT NULL DEFAULT 'upload',
    device                 VARCHAR(20)  NOT NULL DEFAULT 'cpu',
    config_snapshot        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    total_image_count      INTEGER      NOT NULL DEFAULT 0,
    total_count            INTEGER,
    avg_confidence         DOUBLE PRECISION,
    total_elapsed_secs     DOUBLE PRECISION,
    notes                  TEXT,
    -- 003
    name                   VARCHAR(200) NOT NULL,
    -- 006
    processed_image_count  INTEGER      NOT NULL DEFAULT 0,
    failed_at              TIMESTAMPTZ,
    failure_reason         TEXT,
    -- 007
    classes                JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- 010
    user_id                UUID,
    CONSTRAINT fk_analysis_batch_user_id_user_account
        FOREIGN KEY (user_id) REFERENCES user_account(id) ON DELETE RESTRICT
);
CREATE INDEX idx_batch_created_at  ON analysis_batch (created_at);
CREATE INDEX idx_batch_status      ON analysis_batch (status);
CREATE INDEX idx_batch_organism    ON analysis_batch (organism_type);
CREATE INDEX idx_batch_user_created ON analysis_batch (user_id, created_at DESC);

-- =============================================================================
-- analysis_image  (001 + 002 edited_annotations + 008 annotations)
-- =============================================================================
CREATE TABLE analysis_image (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id            UUID         NOT NULL REFERENCES analysis_batch(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    original_filename   VARCHAR(500) NOT NULL,
    original_width      INTEGER,
    original_height     INTEGER,
    file_size_bytes     BIGINT,
    file_hash           VARCHAR(64),
    status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
    error_message       TEXT,
    count               INTEGER,
    avg_confidence      DOUBLE PRECISION,
    elapsed_secs        DOUBLE PRECISION,
    annotations         JSONB,
    overlay_path        VARCHAR(1000),
    tile_count          INTEGER,
    -- 002
    edited_annotations  JSONB
);
CREATE INDEX idx_image_batch_id  ON analysis_image (batch_id);
CREATE INDEX idx_image_filename  ON analysis_image (original_filename);

-- =============================================================================
-- app_settings  (001) — singleton row enforced via CHECK
-- =============================================================================
CREATE TABLE app_settings (
    id                INTEGER      PRIMARY KEY DEFAULT 1,
    image_storage_dir VARCHAR(1000) NOT NULL,
    data_dir          VARCHAR(1000),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT ck_app_settings_singleton CHECK (id = 1)
);

-- =============================================================================
-- custom_model  (004 + 005 organism)
-- =============================================================================
CREATE TABLE custom_model (
    id                 UUID         PRIMARY KEY,
    original_filename  VARCHAR(255) NOT NULL,
    stored_path        TEXT         NOT NULL,
    file_size_bytes    INTEGER      NOT NULL,
    uploaded_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    is_valid           BOOLEAN      NOT NULL DEFAULT false,
    -- 005
    organism           VARCHAR(20)  NOT NULL
);
CREATE INDEX ix_custom_model_organism_uploaded_at
    ON custom_model (organism, uploaded_at);

-- =============================================================================
-- model_assignment  (004)
-- =============================================================================
CREATE TABLE model_assignment (
    organism         VARCHAR(20) PRIMARY KEY,
    custom_model_id  UUID        REFERENCES custom_model(id) ON DELETE SET NULL,
    assigned_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- alembic_version — mark schema as up-to-date with revision 010
-- =============================================================================
CREATE TABLE IF NOT EXISTS alembic_version (
    version_num VARCHAR(32) NOT NULL,
    CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
INSERT INTO alembic_version (version_num) VALUES ('010')
    ON CONFLICT (version_num) DO NOTHING;
