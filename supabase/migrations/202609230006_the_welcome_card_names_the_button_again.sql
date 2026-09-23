-- The welcome card names the button that is actually on screen — again.
--
-- THIS IS THE SECOND TIME, and that is the interesting part. The row was
-- seeded by 202609030004 naming "כתיבת פוסט". 202609150007 corrected it to
-- "מה קורה היום?" when the composer was renamed. #33 renamed the composer a
-- third time, to "מה עשית היום?", and the stored body went stale again — on
-- the first card a new member ever reads.
--
-- #33 could not fix it: one open branch adds a migration at a time, and #33
-- was not the one holding the slot. It shipped a client-side stopgap instead
-- (RETIRED_COMPOSER_LABELS in src/community/club.js), wrote down that the
-- real repair was this UPDATE, and said the list should not survive. This is
-- that follow-up, and the list goes with it.
--
-- WHY THE STOPGAP IS WORSE THAN THIS, and not merely redundant. It rewrote
-- ANY stored body, including one a club had written for itself: a club whose
-- own words happened to contain "מה קורה היום?" would have had them silently
-- edited on the way to the screen. A guarded UPDATE cannot do that, because
-- it skips exactly the rows a human has touched.
--
-- TWO GUARDS, not one.
--
--   updated_by is null   The pin trigger stamps auth.uid() the moment a human
--                        saves that row from the panel, so this corrects copy
--                        that is still the shipped default and silently skips
--                        anything the club has made its own. Same guard
--                        202609150007 used, for the same reason.
--
--   the body still names a retired label
--                        So this is a true no-op on a row that is already
--                        right, rather than a rewrite that happens to produce
--                        the same text. It also means a fourth rename needs a
--                        fourth migration rather than silently re-running
--                        this one against different text.
--
-- The composer label itself lives in exactly one place in the client
-- (POST_COMPOSER_PLACEHOLDER, cloud.js). This migration is the database's
-- copy of that decision, and the two are checked against each other by
-- test/first-run-copy.test.mjs.
update public.onboarding_step_content
   set body = 'כאן רואים מה קורה במועדון, ואפשר לשתף אימונים ושיאים ולהגיב לחברים אחרים. השורה "מה עשית היום?" בראש הפיד פותחת את השיתוף הראשון שלכם.'
 where step = 'welcome'
   and updated_by is null
   and (body like '%מה קורה היום?%' or body like '%כתיבת פוסט%');
