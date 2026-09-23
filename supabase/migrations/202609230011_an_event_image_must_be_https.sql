-- AUDIT-RECON-003 / launch-readiness N8: events.image_url accepts any scheme.
--
-- The existing check is length only (<= 500). Nothing stops `javascript:`,
-- `data:` or plain `http://` being stored.
--
-- WHY IT IS STILL WORTH DOING, given it is already contained. Only staff can
-- write this column, `esc()` escapes it on the way out, and the CSP's
-- `img-src` would refuse to load anything but an allowed origin — three
-- layers, and the audit correctly rated it nice-to-have rather than a
-- blocker. The reason to add a fourth is that all three are properties of
-- code that could change, and this one is a property of the data: a column
-- that cannot hold a hostile URL cannot leak one if a future renderer forgets
-- to escape, or a future CSP relaxes img-src to fix an unrelated bug.
--
-- `http://` is refused as well as the dangerous schemes. A mixed-content
-- image on an HTTPS page does not load in any current browser, so an http URL
-- here is a broken image with a privacy leak attached, not a working one.
alter table public.events drop constraint if exists events_image_url_check;

alter table public.events
  add constraint events_image_url_check
  check (
    image_url is null
    or (char_length(image_url) <= 500 and image_url ~* '^https://')
  );

comment on constraint events_image_url_check on public.events is
  'An event image must be an https URL of at most 500 characters (202609230011, AUDIT-RECON-003). Scheme-checked in the column rather than only at render: esc() and the CSP''s img-src already contain it, but both are properties of code, and this one is a property of the data.';
