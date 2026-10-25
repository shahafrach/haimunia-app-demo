-- Every table in public has row level security enabled.
--
-- RLS is what stands between one member's rows and the next. A table created
-- without `enable row level security` is readable by whoever holds a grant,
-- and the default privileges give the API roles one. Read from pg_class so a
-- table added later fails here, not in review.
--
-- Enabled, not forced: the owner role is the one definer functions run as.

create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions;
select * from no_plan();

select ok((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p')) > 0,
  'the guard sees tables in public (it is not passing on an empty set)');

select is_empty(
  $$ select c.relname::text
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'every table in public has row level security enabled');

select * from finish();
rollback;
