from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    FetchedValue,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    func,
)
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Region(Base):
    __tablename__ = "regions"

    region_code: Mapped[str] = mapped_column(String(16), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())


class PlatformUser(Base):
    __tablename__ = "platform_users"

    id: Mapped[int] = mapped_column(
        mysql.BIGINT(unsigned=True).with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    tenant_key: Mapped[str] = mapped_column(String(128), nullable=False)
    open_id: Mapped[str] = mapped_column(String(128), nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    platform_role: Mapped[str] = mapped_column(
        Enum("USER", "ADMIN", name="platform_role", native_enum=True),
        nullable=False,
        default="USER",
        server_default="USER",
    )
    organizational_scope: Mapped[str] = mapped_column(
        Enum("matrix", "regional", "base", name="organizational_scope", native_enum=True),
        nullable=False,
    )
    # Feishu is the source of the user's organizational assignment. In
    # particular, home_region intentionally has no FK to the regions catalog.
    home_region: Mapped[str | None] = mapped_column(String(16), nullable=True)
    home_base: Mapped[str | None] = mapped_column(String(128), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )


class UserRegionAccess(Base):
    __tablename__ = "user_region_access"

    user_id: Mapped[int] = mapped_column(ForeignKey("platform_users.id", ondelete="CASCADE"), primary_key=True)
    region_code: Mapped[str] = mapped_column(ForeignKey("regions.region_code"), primary_key=True)
    granted_by_user_id: Mapped[int] = mapped_column(ForeignKey("platform_users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())


class UserAccessAudit(Base):
    __tablename__ = "user_access_audit"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    actor_type: Mapped[str] = mapped_column(
        Enum("admin", "bootstrap", name="user_access_actor_type", native_enum=True),
        nullable=False,
    )
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("platform_users.id"), nullable=True)
    target_user_id: Mapped[int] = mapped_column(ForeignKey("platform_users.id"), nullable=False)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    old_platform_role: Mapped[str | None] = mapped_column(
        Enum("USER", "ADMIN", name="user_access_old_role", native_enum=True), nullable=True
    )
    new_platform_role: Mapped[str | None] = mapped_column(
        Enum("USER", "ADMIN", name="user_access_new_role", native_enum=True), nullable=True
    )
    old_is_active: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    new_is_active: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    regions_added: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    regions_removed: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.current_timestamp())


class PlatformUserFeishuProfile(Base):
    """Informational Feishu organization profile stored outside authorization fields."""

    __tablename__ = "platform_user_feishu_profiles"
    __table_args__ = (
        Index("ix_platform_user_feishu_profiles_union_id", "union_id"),
        Index(
            "ix_platform_user_feishu_profiles_organizational_region_code",
            "organizational_region_code",
        ),
    )

    # Matches the manually provisioned MySQL table while retaining
    # SQLite-compatible identifiers for isolated tests.
    user_id: Mapped[int] = mapped_column(
        mysql.BIGINT(unsigned=True).with_variant(Integer, "sqlite"),
        ForeignKey("platform_users.id", ondelete="CASCADE"),
        primary_key=True,
        autoincrement=False,
    )
    union_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    department_paths: Mapped[list[list[str]] | None] = mapped_column(JSON, nullable=True)
    organizational_region_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    region_resolution_status: Mapped[str] = mapped_column(
        Enum(
            "RESOLVED", "UNKNOWN", "AMBIGUOUS", "SYNC_FAILED",
            name="feishu_region_resolution_status",
            native_enum=True,
        ),
        nullable=False,
        default="UNKNOWN",
        server_default="UNKNOWN",
    )
    last_successful_sync_at: Mapped[datetime | None] = mapped_column(
        mysql.DATETIME(fsp=6).with_variant(DateTime(), "sqlite"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        mysql.TIMESTAMP().with_variant(DateTime(), "sqlite"),
        nullable=False,
        server_default=func.current_timestamp(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        mysql.TIMESTAMP().with_variant(DateTime(), "sqlite"),
        nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
        server_onupdate=FetchedValue(),
    )
