-- ============================================================================
-- Rush Tracker — add 'partial' to client_segment.
--
-- Splits the old two-way segment into three: 'prepaid' now means pay the
-- FULL amount (non-editable), 'partial' takes over the old 'prepaid'
-- behavior (pay some now, editable, rest becomes due), 'postpaid' is
-- unchanged. See 20260723000021 for the data migration and RPC update —
-- kept in a separate file because a newly-added enum value can't safely be
-- used in the same transaction it was created in.
-- ============================================================================

alter type public.client_segment add value 'partial';
