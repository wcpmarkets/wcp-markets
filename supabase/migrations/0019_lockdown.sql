-- Phase 2 M8 hardening (Fable review). The KYC gate (profiles.verification_level) is
-- now LOAD-BEARING for money — so a client being able to write it is a KYC bypass:
-- any authenticated user could PATCH verification_level=2 via PostgREST and get paid
-- out without ever passing a BVN/NIN match. Close it, and the class of hole.

-- The API writes profiles via the service role; the client update policy was pure
-- attack surface.
drop policy if exists profiles_update_own on public.profiles;

-- Defense-in-depth across the whole schema: clients NEVER write app tables directly
-- (the service-role API does; Realtime only READS, gated by RLS SELECT policies). So
-- revoke write grants — a stray future RLS policy then can't reopen a bypass. The
-- service_role bypasses this (BYPASSRLS + its own grants); new tables must re-assert.
revoke insert, update, delete on all tables in schema public from authenticated, anon;
