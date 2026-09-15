-- The first sixty seconds a new member spends in this app.
-- Pre-launch review, 2026-09-15. Three defects, all in seeded copy, all of
-- them invisible to every test in the repo because a test can check that a
-- string renders and cannot check that the string is TRUE.
--
-- NEVER CLOBBERS AN EDIT. Every update below is guarded on
-- `updated_by is null`, which the pin trigger sets to auth.uid() the moment a
-- human saves that row from the panel. So this corrects copy that is still the
-- shipped default and silently skips anything the club has already made its
-- own - which is the whole point of those editors existing.
--
-- ---------------------------------------------------------------------
-- 1. The welcome card pointed at a button that no longer exists.
-- ---------------------------------------------------------------------
-- It said: לחיצה על "כתיבת פוסט" למעלה. That control was redesigned into the
-- standard fake-input composer row, which reads "מה קורה היום?" - so the FIRST
-- card a new member ever sees told them to tap something not on the screen.
--
-- The two strings are coupled and nothing enforced it. A test now asserts they
-- agree (test/first-run-copy.test.mjs), so the next person who rewords the
-- composer finds out here instead of in a member's first session.
update public.onboarding_step_content
   set body = 'כאן רואים מה קורה במועדון, ואפשר לשתף אימונים ושיאים ולהגיב לחברים אחרים. השורה "מה קורה היום?" בראש הפיד פותחת את השיתוף הראשון שלכם.'
 where step = 'welcome'
   and updated_by is null;

-- ---------------------------------------------------------------------
-- 2. The intro carousel promised information this app does not hold.
-- ---------------------------------------------------------------------
-- Screen 2 said the opening hours, dress code, equipment rules and
-- cancellation policy were "זמין תמיד בלשונית הקהילה". That sentence existed
-- in exactly one place in the entire codebase: its own default row. None of
-- that content is anywhere in the app.
--
-- A promise made on screen 2 of a new member's first session, and broken on
-- screen 3, is worse than saying nothing - it teaches them the app is not to
-- be relied on before they have used a single feature of it. Replaced with
-- something that is true whatever the club has or has not written down yet,
-- and that routes them to the people who actually know.
update public.intro_carousel_content
   set body = 'שעות הפעילות, הציוד והנהלים - המאמנים/ות מעדכנים בכל מה שצריך לדעת. אפשר לשאול אותם/ן כל דבר, זה בדיוק מה שהם כאן בשבילו.'
 where step = 'club_rules'
   and updated_by is null;

-- Screen 3 said קבעו אימון היכרות עם מאמן/ת - an instruction the app cannot
-- help with and gave no route to. Class booking is Arbox's job, deliberately:
-- this app is opened AFTER training, to record and review it. Telling a new
-- member to do something here that cannot be done here sets exactly the wrong
-- expectation of what they just installed, so screen 3 now says what the app
-- IS for.
update public.intro_carousel_content
   set body = 'קביעת האימונים נמשכת במערכת שאתם כבר מכירים. כאן רושמים מה עשיתם אחרי האימון - וזה מה שבונה לכם תמונה של ההתקדמות לאורך זמן.'
 where step = 'getting_started'
   and updated_by is null;

-- ---------------------------------------------------------------------
-- These are DEFAULTS, and better ones are the club's own words.
-- ---------------------------------------------------------------------
-- All five onboarding cards and all three carousel screens are editable from
-- ניהול המועדון. Nothing above is meant to be final - it is meant to be true
-- until somebody writes something better, which is a different and much lower
-- bar than what was here before.
comment on table public.intro_carousel_content is
  'Redesign Phase 3. Editable title/body for the three first-run intro-carousel screens shown once to a brand-new member, before profile completion - a sibling of onboarding_step_content (202609030004), not an extension of it: that table is a closed five-row RECURRING lifecycle system; this is a closed three-row ONE-TIME first-run system, and the two share no code path. Exactly three rows, always: no insert and no delete grant for any client role. Any authenticated member may read all three (no privacy dimension); only community.content.manage_onboarding or is_admin() may update - the same permission and the same onboarding_content_updated/onboarding_step admin_actions label onboarding_step_content''s own edits use. step, updated_by and updated_at are pinned server-side by a trigger. SEEDED COPY MUST BE TRUE OF THIS APP (202609150007): the original club_rules row promised opening hours and a cancellation policy were "always available in the Community tab" and no such content exists anywhere, and getting_started told a new member to book a session the app cannot book. Copy here is read by people who have used nothing else yet, so a promise broken on screen 3 costs more than a bland sentence.';
