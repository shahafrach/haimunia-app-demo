# Owner-guide build tools

`make-shots.mjs` drives the app in real Chromium against the mock backend and
writes the screenshots; `make-pdf.mjs` renders `docs/owner-guide/guide.html`
to PDF. Run them when the guide needs regenerating, not otherwise:

    node scripts/owner-guide/make-shots.mjs
    node scripts/owner-guide/make-pdf.mjs

## Why they are not in scripts/browser-check/

That is where they started, and `run-all.mjs` globs every `.mjs` in that
directory - so CI executed them as though they were regression checks. They
are not. They produce a deliverable; there is nothing in them that can fail in
a way that should stop a build.

It also went wrong in the obvious way. `make-shots.mjs` finished without
closing its target server, which keeps node alive indefinitely, and the
browser-checks job sat in_progress for four hours on 2026-09-17 reporting
nothing - worse than a red build, because branch protection reads a job that
never finishes as "expected" rather than "failed" and the push goes through.

`run-all.mjs` now kills anything that overruns eight minutes and reports HUNG
separately from FAIL, so that specific failure cannot recur silently. These
two moved here anyway, because the timeout is a backstop and not a reason to
keep build tools inside a test glob.

## Their output is deliberately not in git

`docs/owner-guide/` is gitignored. It contains the PDF, the screenshots and -
the reason - a QR encoding a live club join code, which was committed on
2026-09-16 and was a public URL within the hour, because this repo deploys
verbatim to the web. The guide is sent to the owner directly. It is not
hosted, and nothing generated here should be committed.
