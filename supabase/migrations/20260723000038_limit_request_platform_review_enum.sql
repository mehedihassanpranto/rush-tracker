-- ============================================================================
-- Limit requests on platform-assigned accounts route through the platform for
-- approval (spec §4.3 of the "Mother Platform Account Control" doc), instead
-- of the agency approving directly the way it does for agency-owned accounts.
--
-- A newly-added enum value cannot be referenced in the same transaction that
-- creates it, so this is split into two migrations — this one only adds the
-- value; 20260723000039 does everything that uses it.
-- ============================================================================

alter type public.limit_request_status add value 'PENDING_PLATFORM_REVIEW';
