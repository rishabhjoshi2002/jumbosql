-- +goose Up

-- JumboSQL: console users and login sessions.
-- auth_provider is 'local' for users stored here; later providers (LDAP, OIDC/SSO) create rows with their
-- own provider name and no password_hash, so roles and sessions work the same for every provider.
create table if not exists public.users (
  user_id       bigserial primary key,
  username      text        not null,
  display_name  text,
  password_hash text,
  role          text        not null default 'viewer' check (role in ('admin', 'operator', 'viewer')),
  auth_provider text        not null default 'local',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  last_login_at timestamptz
);

create unique index if not exists users_username_provider_uidx on public.users (lower(username), auth_provider);

-- Only a SHA-256 of the session token is stored, never the token itself.
create table if not exists public.user_sessions (
  token_hash  text        primary key,
  user_id     bigint      not null references public.users (user_id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text
);

create index if not exists user_sessions_user_id_idx on public.user_sessions (user_id);
create index if not exists user_sessions_expires_at_idx on public.user_sessions (expires_at);

-- +goose Down
drop table if exists public.user_sessions;
drop table if exists public.users;
