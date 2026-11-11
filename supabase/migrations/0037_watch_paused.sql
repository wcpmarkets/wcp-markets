-- 20k: each watch has an on/off switch. A paused watch keeps its hits but catches
-- nothing new (the consumer skips it) until it's switched back on.
alter table public.watches add column if not exists paused boolean not null default false;
