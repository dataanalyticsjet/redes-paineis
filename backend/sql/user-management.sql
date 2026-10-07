-- Redes Painéis user administration schema.
-- Target: MySQL 8+. This file is intentionally not executed by the application.
-- Populate `regions` only from the approved corporate regional catalog.

CREATE TABLE regions (
    region_code VARCHAR(16) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (region_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_key VARCHAR(128) NOT NULL,
    open_id VARCHAR(128) NOT NULL,
    email VARCHAR(320) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    platform_role ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    organizational_scope ENUM('matrix', 'regional', 'base') NOT NULL,
    -- Feishu is authoritative for this assignment. Do not add an FK here:
    -- an unlisted Feishu home region must not prevent login/provisioning.
    home_region VARCHAR(16) NULL,
    home_base VARCHAR(128) NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_platform_users_feishu_identity (tenant_key, open_id),
    KEY ix_platform_users_email (email),
    KEY ix_platform_users_active_role (is_active, platform_role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_region_access (
    user_id BIGINT UNSIGNED NOT NULL,
    region_code VARCHAR(16) NOT NULL,
    granted_by_user_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, region_code),
    CONSTRAINT fk_user_region_access_user
        FOREIGN KEY (user_id) REFERENCES platform_users(id) ON DELETE CASCADE,
    CONSTRAINT fk_user_region_access_region
        FOREIGN KEY (region_code) REFERENCES regions(region_code),
    CONSTRAINT fk_user_region_access_granted_by
        FOREIGN KEY (granted_by_user_id) REFERENCES platform_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_access_audit (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    actor_type ENUM('admin', 'bootstrap') NOT NULL,
    actor_user_id BIGINT UNSIGNED NULL,
    target_user_id BIGINT UNSIGNED NOT NULL,
    action VARCHAR(40) NOT NULL,
    old_platform_role ENUM('USER', 'ADMIN') NULL,
    new_platform_role ENUM('USER', 'ADMIN') NULL,
    old_is_active TINYINT(1) NULL,
    new_is_active TINYINT(1) NULL,
    regions_added JSON NOT NULL,
    regions_removed JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_user_access_audit_target_time (target_user_id, created_at),
    KEY ix_user_access_audit_actor_time (actor_user_id, created_at),
    CONSTRAINT fk_user_access_audit_actor
        FOREIGN KEY (actor_user_id) REFERENCES platform_users(id),
    CONSTRAINT fk_user_access_audit_target
        FOREIGN KEY (target_user_id) REFERENCES platform_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- No regions are seeded here. Load only the approved catalog through a
-- separately reviewed manual SQL step before granting additional regions.

-- First-admin bootstrap is a separate, reviewed manual transaction after the
-- user's first successful Feishu login has provisioned them as USER:
--   START TRANSACTION;
--   SELECT id, platform_role, is_active FROM platform_users
--     WHERE tenant_key = '<verified-tenant-key>' AND open_id = '<verified-open-id>'
--     FOR UPDATE;
--   -- Confirm exactly one active USER row and record its id as @target_user_id.
--   UPDATE platform_users SET platform_role = 'ADMIN'
--     WHERE id = @target_user_id AND platform_role = 'USER' AND is_active = 1;
--   INSERT INTO user_access_audit
--     (actor_type, actor_user_id, target_user_id, action,
--      old_platform_role, new_platform_role, old_is_active, new_is_active,
--      regions_added, regions_removed)
--     SELECT 'bootstrap', NULL, id, 'initial_admin_bootstrap',
--            'USER', 'ADMIN', 1, 1, JSON_ARRAY(), JSON_ARRAY()
--       FROM platform_users WHERE id = @target_user_id AND platform_role = 'ADMIN';
--   -- Verify one update and one audit row, then COMMIT; otherwise ROLLBACK.
