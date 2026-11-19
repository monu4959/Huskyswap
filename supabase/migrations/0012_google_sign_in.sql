-- Sign in with Google.
--
-- enforce_nu_email (schema.sql) only let @northeastern.edu addresses register.
-- Google sign-in proves the person owns the Google account, so Google accounts
-- may use any email (most students sign in with a personal Gmail). Email
-- sign-ups (the email-code / demo path) stay Northeastern-only.
--
-- The provider comes from raw_app_meta_data, which Supabase Auth sets and users
-- can't write (it's app metadata, not user metadata).
--
-- Also: new Google accounts arrive with their Google name in user metadata
-- (`name`, or `full_name`); handle_new_user already prefers `name`, and now
-- falls back to `full_name` before the email's local part.
--
-- Safe to run more than once.

create or replace function public.enforce_nu_email()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  via_google boolean := coalesce(new.raw_app_meta_data ->> 'provider', '') = 'google'
                        or coalesce(new.raw_app_meta_data -> 'providers', '[]'::jsonb) ? 'google';
begin
  if new.email is null then
    raise exception 'An email address is required';
  end if;
  if not via_google and lower(new.email) !~ '^[^@]+@northeastern\.edu$' then
    raise exception 'Only @northeastern.edu email addresses can register without Google';
  end if;
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
                  nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
                  split_part(new.email, '@', 1)), 80)
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.enforce_nu_email() from public, anon, authenticated;
