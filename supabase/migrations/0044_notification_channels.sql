-- Email and SMS delivery for notifications (alongside FCM push).
--
-- `notifications.status` stays the push outcome. Each extra channel records its own
-- outcome on the same row, so one notification shows what happened everywhere:
--
--   null      the channel wasn't attempted for this notification (switched off, or the
--             notification isn't one that channel carries — SMS is only for the urgent
--             money moments)
--   sent      handed to the provider (Resend / Termii)
--   mocked    no provider key yet: logged, not sent
--   no_address  no confirmed email / no phone on the account
--   throttled   email only: a chat already emailed in the last hour
--   failed    the provider refused or was unreachable (detail has the reason)
--
-- Every SMS is also written to sms_log (kind 'notification'), like security alerts.

alter table public.notifications
  add column if not exists email_status text
    check (email_status in ('sent', 'mocked', 'no_address', 'throttled', 'failed')),
  add column if not exists sms_status text
    check (sms_status in ('sent', 'mocked', 'no_address', 'failed'));

alter table public.sms_log
  add column if not exists notification_id bigint references public.notifications (id) on delete set null;

-- The chat-email throttle looks up a user's recent message emails per conversation.
create index if not exists notifications_email_recent
  on public.notifications (user_id, created_at desc)
  where email_status in ('sent', 'mocked');
