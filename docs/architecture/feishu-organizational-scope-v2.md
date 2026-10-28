# Feishu organizational scope V2

## Status and activation

The new policy is isolated behind FEISHU_ORG_SCOPE_V2_ENABLED, default false.
With the flag off, the existing resolver and manual-grant fallback remain in effect.
The V2 resolver does not change platform roles or administrative grants.

FEISHU_ORG_SCOPE_PROFILE_TTL_SECONDS defaults to 900 seconds (15 minutes; allowed
configuration range 60 seconds to 7 days). Login continues to synchronize the
Feishu profile. While V2 is enabled, each authenticated request checks profile
freshness before calculating access. The dashboard also refreshes /api/auth/me
periodically; the server remains the authority for data queries and exports.

When a profile expires, the request revalidates it before returning data. If
Contacts is unavailable or the refresh cannot be persisted, the previous scope
is denied immediately (SYNC_FAILED/unknown) and retried no more than once per
minute per process. A successful revalidation replaces the previous paths and
scope before that request is authorized. Already-open sessions are not revoked;
their scope is recomputed at the next authenticated request, and no later than
the configured TTL after the last successful sync.

## Confirmed hierarchy rules

The V2 resolver uses stable department IDs, complete parent-to-child paths, and
preserves path boundaries. A more specific mapped descendant overrides an
ancestor only within that same path. Independent memberships must resolve to
the same region.

- Noroeste defaults to GP; its Pará descendant resolves to PA; Goiás resolves to GP.
- MN is an unmapped grouping department. Direct MN and unmapped functional
  descendants remain restricted with reason mn_rule_pending. The confirmed MG and
  SPN descendants resolve to their own regions.
- BA, SPS, RJ, CE, PR, SPE, SR, MG, SPN, PA, and GP use the confirmed IDs in
  backend/app/services/feishu_regions.py.
- Regional Sponsor paths, incomplete/external paths, conflicting memberships,
  and unknown descendants that cannot inherit a confirmed regional branch
  never receive a data scope.
- MATRIZ is granted only for the confirmed J&T Brasil root membership itself.
  Other corporate descendants are left restricted until their memberships are
  explicitly validated. This intentionally favors denial over inferred access.

MATRIZ is an organizational data scope only; it never assigns ADMIN.
Administrative scope and platform role continue to come from the existing
server-side user record. Existing ADMIN/MATRIZ checks remain separate.

## Server-side coverage

All authenticated API routes use the shared viewer dependency. In V2 it
revalidates stale organization profiles and constructs one effective identity.
Data Foundation SQL scope clauses, workbook row scoping, source reads, exports,
and operational report routes consume that identity. Unknown V2 users do not
fall back to saved manual regional grants. The frontend's region selectors are
only presentation; they do not grant access.

## Profile storage and audit

The existing platform_user_feishu_profiles snapshot already stores department
IDs/paths, resolved code/status, and last successful sync time. No schema change
is required to resolve current access or MN pending status; the V2 reason is
computed from the stored paths and is returned without exposing paths or IDs to
the browser. Successful syncs that change the V2 result emit a sanitized
structured application log with internal user ID, old/new scope/status, and
rule version. The table does not retain a durable history of prior paths or
reasons. If long-term audit retention is a production requirement, it needs a
separate reviewed schema change; no SQL or migration is included here.

No Feishu credentials or tokens are logged. All API behavior in tests is mocked.

The legacy workbook history index returns only part IDs that contain rows visible to
an authorized regional identity under V2. The separate national responsibility
summary is restricted to MATRIZ under V2; regional dashboards use the normal
row-scoped workbook response. Data Foundation date/publication counts, records,
pagination, and CSV exports carry the same server-resolved identity into the
query plan.
