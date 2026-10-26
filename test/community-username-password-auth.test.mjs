// Plain anonymous-only sign-in (no email, no password) had a real,
// user-reported problem: there was no way to log back into the same
// account from a different device or after clearing site data - every
// fresh session was a disconnected identity with its own invite-code
// redemption and profile, "a mess" in the user's own words. Replaced
// with a real username + password account, still with no actual email
// ever collected or sent: a brand-new member redeems the invite code on
// a throwaway anonymous session (needed only because redeem_invite_code
// requires some session to attach to), then immediately sets a
// username + password, which upgrades that same auth.uid() to a
// permanent account via Supabase's supported anonymous-user-conversion
// path (client.auth.updateUser). A returning member just signs in with
// those credentials on any device and reaches the same account, same
// data - the thing anonymous-only sign-in structurally couldn't offer.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { cloudSource } from "./helpers/community-src.mjs";

// The community layer, not one file of it: cloud.js is being split into
// src/community/*.js, and what this test asserts is a property of the layer.
// Every pattern below is unchanged.
const src = cloudSource();

test("the synthetic email is built locally from a username, never collected as real email, using the RFC 2606 .invalid TLD", () => {
  assert.match(src, /function usernameToEmail\(username\) \{ return `\$\{username\}@members\.haimuniya\.invalid`; \}/);
});

test("login() signs in with the synthetic email + typed password, and does not create a new session type", () => {
  assert.match(src, /async function login\(form\)/);
  // Wrapped in withCaptcha() (SEC-004): the credentials object is built the
  // same way and merged with { options: { captchaToken } } only when a site
  // key is configured. Still a password grant, still no new session type.
  //
  // WIDENED 2026-09-15. This used to pin the literal expression
  // `{ email: usernameToEmail(username), password }`. login() now accepts a
  // real email as well as a username, so the email argument is a conditional
  // - but the two properties this test is actually about are unchanged and
  // are what it now asserts: a USERNAME still resolves through
  // usernameToEmail() (no real address is invented or collected for an
  // ordinary member), and the call is still signInWithPassword.
  assert.match(src, /client\.auth\.signInWithPassword\(Object\.assign\(/);
  assert.match(src, /looksLikeEmail \? identifier : usernameToEmail\(identifier\)/);
  // And nothing in login() reaches for a different session type.
  const loginBody = src.slice(src.indexOf("async function login(form)"), src.indexOf("async function setCredentials(form)"));
  assert.ok(!/signInAnonymously|signInWithOtp|signInWithOAuth/.test(loginBody),
    "login() must stay a password grant - no other session type may appear in it");
});

test("a real email is accepted at login, so the one account that must be recoverable without another admin can be", () => {
  // The club's own admin account is created with a real address precisely so
  // Supabase's own password-reset mail works for it - "ask an admin to reset
  // it" has no answer when the locked-out person IS the only admin. That
  // account's email is not derivable from any username, so login has to
  // accept it verbatim.
  assert.match(src, /const looksLikeEmail = identifier\.includes\("@"\);/);
  // Deliberately NOT a validating regex: the server is the authority on
  // whether an address exists, and a stricter client test could only ever
  // lock someone out of their own account over a technicality.
  const loginBody = src.slice(src.indexOf("async function login(form)"), src.indexOf("async function setCredentials(form)"));
  assert.ok(!/\[a-z\]\+@|EMAIL_RE|isValidEmail/.test(loginBody),
    "login() must not second-guess the server on what a valid address looks like");
});

test("account CREATION stays username-only - accepting an email to log in did not start collecting them", () => {
  // The whole point of the .invalid domain is that this club holds no email
  // addresses for ordinary members. login() widening must not have leaked
  // into setCredentials(), which is where an ordinary account is minted.
  const start = src.indexOf("async function setCredentials(form)");
  // +1 so indexOf does not match setCredentials' own declaration at offset 0.
  const body = src.slice(start, src.indexOf("async function", start + 1));
  assert.match(body, /usernameToEmail\(username\)/,
    "signup still maps a username onto the synthetic domain");
  assert.ok(!/includes\("@"\)/.test(body),
    "and signup does NOT accept a real address - that path is deliberately not offered to members");
});

test("setCredentials() upgrades the anonymous session in place via updateUser, and refreshes state.user from the result", () => {
  assert.match(src, /async function setCredentials\(form\)/);
  // Wrapped in withCaptcha() (SEC-004). updateUser takes the captchaToken
  // as its second argument rather than inside the attributes object, which
  // is why this call's shape differs from signInWithPassword's above.
  assert.match(src, /client\.auth\.updateUser\(\s*\n\s*\{ email: usernameToEmail\(username\), password \},\s*\n\s*captchaToken \? \{ captchaToken \} : undefined,/);
  assert.match(src, /state\.user = data\.user;/);
});

test("startSignup() begins the anonymous bootstrap only when explicitly chosen, not automatically on load", () => {
  // gateView is cleared alongside signupStarted since design spec section 7
  // split the gate into a choice screen and a login screen: backing out of
  // the invite step later must land on the choice screen, not silently
  // reopen a login form the member visited earlier in the same session. The
  // property this test actually guards - that the anonymous bootstrap fires
  // only from an explicit tap, never on load - is unchanged.
  assert.match(src, /function startSignup\(\) \{ state\.signupStarted = true; state\.ui\.gateView = ""; ensureAnonymousSession\(\); rerender\(\); \}/);
});

test("the gate order is: choice-or-login -> (bootstrap) -> invite code -> set credentials (only while still anonymous) -> profile -> app", () => {
  const start = src.indexOf("function renderCircleGate(opts) {");
  const end = src.indexOf("// The invite step: paste a link", start);
  const body = src.slice(start, end);

  // Design spec section 7. The pre-session gate used to be ONE screen that
  // led with the login form; it is now two, and the FIRST one is the neutral
  // choice screen, because for a club rolling this out every arriving member
  // is new and a login form was the primary action almost nobody needed.
  // Both still sit before the bootstrap, which is what this ordering test is
  // really about.
  const choiceGate = body.indexOf('if (!state.signupStarted && state.ui.gateView !== "login") {');
  const loginGate = body.indexOf("if (!state.signupStarted) {");
  const bootstrapGate = body.indexOf("ensureAnonymousSession();");
  const redemptionGate = body.indexOf("if (!inAny && !state.redemption && !meWithoutCircle) return renderJoinStep();");
  const credentialsGate = body.indexOf("if (state.user.is_anonymous) {");
  const profileGate = body.indexOf("if (!state.profile ||");

  assert.ok(choiceGate > -1, "the gate must open on the neutral choice screen before any session exists");
  assert.ok(loginGate > choiceGate, "and the login form must be a screen of its own, reached from that choice");
  assert.ok(bootstrapGate > loginGate, "anonymous bootstrap must only run after login-or-start, not before");
  assert.ok(redemptionGate > bootstrapGate, "invite code gate comes after the user has some session");
  assert.ok(credentialsGate > redemptionGate, "credentials must be set right after redeeming the code");
  assert.ok(profileGate > credentialsGate, "profile completion is the last gate, only once the account is permanent");
});

test("a returning member who signs in with real credentials never sees the credentials-setup screen (gated on is_anonymous)", () => {
  // What this pins is the GATE - that the credentials screen is reached only
  // for an anonymous session - not the byte layout of the markup after it.
  // The original regex required the heading to be the very next characters
  // after the return, so adding the join-progress indicator above the heading
  // failed a test about authentication. The gate never moved; a test that
  // reports a defect when nothing it describes has changed trains people to
  // edit tests instead of reading them.
  assert.match(src, /if \(state\.user\.is_anonymous\) \{\s*return gateCard\(`[\s\S]{0,400}?יצירת חשבון/);
});

test("the login form and the credentials form each validate independently and clear their own field errors on success", () => {
  assert.match(src, /field\("communityLogin", "username"/);
  assert.match(src, /field\("communityLogin", "password"/);
  assert.match(src, /field\("communityCredentials", "username"/);
  assert.match(src, /field\("communityCredentials", "password"/);
  assert.match(src, /field\("communityCredentials", "passwordConfirm"/);
  // setCredentials() keys its field errors on form.id (not a hardcoded
  // string) since a second form - the standalone backup-only
  // "backupCredentials" in Settings, see community-backup-sync.test.mjs -
  // now shares this same handler.
  assert.match(src, /setFieldErrors\(formId, \{\}\);/);
});

test("sign-out is wired now that logging back in is possible, and resets signupStarted plus the anonymous-attempt guard so a fresh signup can start cleanly afterward", () => {
  assert.match(src, /data-community-action="sign-out"/);
  assert.match(src, /action === "sign-out"\) client\.auth\.signOut\(\)/);
  // COMM-365 regrouped the sign-out reset by namespace, so signupStarted and
  // the anonymous-attempt guard are no longer adjacent lines - both still run
  // in the same block, which is what actually matters.
  const resetStart = src.indexOf("state.profile = null; state.redemption = null;");
  assert.ok(resetStart > -1, "the sign-out reset block must still be findable");
  const signOutReset = src.slice(resetStart, src.indexOf("rerender();", resetStart));
  assert.match(signOutReset, /state\.signupStarted = false;/);
  assert.match(signOutReset, /anonSignInAttempted = false;/);
  assert.match(signOutReset, /recoveryVerifyAttempted = false;/);
});

test("communityLogin and communityCredentials submits are wired to their handlers", () => {
  assert.match(src, /event\.target\.id === "communityLogin"\) \{ event\.preventDefault\(\); login\(event\.target\); \}/);
  assert.match(src, /event\.target\.id === "communityCredentials"\) \{ event\.preventDefault\(\); setCredentials\(event\.target\); \}/);
});
