from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from app.models import PlatformUser, PlatformUserFeishuProfile
from app.services.feishu_contacts import FeishuOrganizationalProfile
from app.services.feishu_profiles import (
    persist_feishu_sync_failure,
    persist_successful_feishu_profile,
)


def test_successful_profile_persists_only_profile_fields(user_test_session_factory):
    with user_test_session_factory() as db:
        user = PlatformUser(
            tenant_key="test-tenant",
            open_id="private-open-id",
            email="profile@example.test",
            display_name="Profile User",
            platform_role="USER",
            organizational_scope="regional",
            home_region="SPS",
            home_base=None,
            is_active=True,
        )
        db.add(user)
        db.commit()
        original = (user.platform_role, user.organizational_scope, user.home_region, user.home_base)

        record = persist_successful_feishu_profile(
            db,
            user.id,
            FeishuOrganizationalProfile(
                union_id="private-union-id",
                avatar_url="https://s3-imfile.feishucdn.com/avatar.png",
                department_paths=[["od-33e90ac1a93b12c1b65347320e648498"]],
            ),
        )

        assert record.organizational_region_code == "MATRIZ"
        assert record.region_resolution_status == "RESOLVED"
        assert record.last_successful_sync_at is not None
        assert (user.platform_role, user.organizational_scope, user.home_region, user.home_base) == original


def test_contacts_failure_preserves_last_successful_region_and_timestamp(user_test_session_factory):
    with user_test_session_factory() as db:
        record = PlatformUserFeishuProfile(
            user_id=41,
            union_id="private-union-id",
            department_paths=[["prior"]],
            organizational_region_code="SPN",
            region_resolution_status="RESOLVED",
        )
        db.add(record)
        db.commit()
        previous_timestamp = record.last_successful_sync_at
        previous_paths = record.department_paths

        failed = persist_feishu_sync_failure(
            db,
            41,
            fallback_union_id="latest-union",
            fallback_avatar_url="https://s3-imfile.feishucdn.com/latest.png",
        )

        assert failed.organizational_region_code == "SPN"
        assert failed.region_resolution_status == "SYNC_FAILED"
        assert failed.last_successful_sync_at == previous_timestamp
        assert failed.department_paths == previous_paths
        assert failed.union_id == "latest-union"
        assert failed.avatar_url == "https://s3-imfile.feishucdn.com/latest.png"


def test_successful_unrecognized_hierarchy_is_unknown_not_matrix(user_test_session_factory):
    with user_test_session_factory() as db:
        record = persist_successful_feishu_profile(
            db,
            42,
            FeishuOrganizationalProfile(None, None, [["unknown-id"]]),
        )
        assert record.organizational_region_code is None
        assert record.region_resolution_status == "UNKNOWN"


def test_success_without_a_usable_avatar_clears_stale_photo(user_test_session_factory):
    with user_test_session_factory() as db:
        db.add(PlatformUserFeishuProfile(
            user_id=43,
            avatar_url="https://s3-imfile.feishucdn.com/expired.png",
            organizational_region_code="PR",
            region_resolution_status="RESOLVED",
        ))
        db.commit()

        record = persist_successful_feishu_profile(
            db,
            43,
            FeishuOrganizationalProfile(None, None, []),
        )

        assert record.avatar_url is None
        assert record.region_resolution_status == "UNKNOWN"

def test_platform_user_feishu_profile_mysql_orm_matches_manual_schema():
    table = PlatformUserFeishuProfile.__table__
    mysql_ddl = str(CreateTable(table).compile(dialect=mysql.dialect()))

    assert table.c.user_id.type.compile(dialect=mysql.dialect()) == "BIGINT UNSIGNED"
    assert table.c.user_id.autoincrement is False
    assert any(
        foreign_key.target_fullname == "platform_users.id"
        and foreign_key.ondelete == "CASCADE"
        for foreign_key in table.c.user_id.foreign_keys
    )
    assert table.c.last_successful_sync_at.type.compile(dialect=mysql.dialect()) == "DATETIME(6)"
    assert table.c.created_at.type.compile(dialect=mysql.dialect()) == "TIMESTAMP"
    assert table.c.updated_at.type.compile(dialect=mysql.dialect()) == "TIMESTAMP"
    assert "AUTO_INCREMENT" not in mysql_ddl
    assert {tuple(index.columns.keys()) for index in table.indexes} == {
        ("union_id",),
        ("organizational_region_code",),
    }
    assert PlatformUser.__table__.c.id.type.compile(dialect=mysql.dialect()) == "BIGINT UNSIGNED"
