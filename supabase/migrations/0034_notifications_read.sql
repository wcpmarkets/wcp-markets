-- In-app notifications list (design 20l): read state. Unread = read_at is null.
alter table public.notifications add column if not exists read_at timestamptz;
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;
