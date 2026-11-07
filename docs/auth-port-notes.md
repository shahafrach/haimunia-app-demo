# Auth port notes: Home → BOX-LOG

Home (`shahafrach/home`, React) was read-only reference. BOX-LOG keeps its own decisions
([decisions.md](circles/decisions.md): anonymous start, username + synthetic address, no email, no SMTP,
recovery code) and takes Home's *behavior*, not its look or data model.

## 1. How Home does it

| Area | Home |
|---|---|
| Signup | Invite-only. A 4-screen swipe guide ("how it works", `SignupGuide`) is shown once before the form (`guideSeen`). Password minimum 10. `enable_signup=false` for the public, signup goes through an Edge Function (`register`). |
| Login | `signInWithPassword`. Hebrew message per Supabase error code (`authErrors.ts`), offline message wins. After 3 wrong passwords a "forgot?" hint. Known-device flag skips the landing. |
| Reset | No email. One-time recovery code → Edge Function `recover-password` (admin `updateUserById`, revokes every session, rotates the code). Email link page also exists for accounts with a real address (`/reset-password`, `PASSWORD_RECOVERY`). |
| Session | `persistSession`, `autoRefreshToken`; stays until logout. Logout clears local data only after the server sign-out worked (`signOutSafely`). Password change → `signOut({scope:'others'})`. |
| TOTP | `mfa.enroll` (QR + secret shown) → `challengeAndVerify`; abandoned unverified factors dropped first. 10 one-time recovery codes. `unenroll` to turn off. |
| Login with TOTP | `getAuthenticatorAssuranceLevel`: `nextLevel=aal2 && currentLevel≠aal2` → the app renders only a code screen (`AuthGate`). Cancel = sign out. |
| Lost phone | Edge Function `mfa-recovery` (`redeem`): recovery code removes the factor, 429 rate limit. |
| Database | MFA enforced **in the client gate only**. No aal policy in any Home migration. |
| Supabase config | `[auth.mfa.totp]` enroll+verify on, `jwt_expiry=3600`, redirect URLs for the reset page. |
| UI | One `GateCard` for every auth step, `aria-describedby` errors, show-password toggle, `autocomplete=one-time-code`, RTL logical classes, in-app-browser (WhatsApp etc.) warning, standalone-PWA detection. |

## 2. Gap analysis for BOX-LOG

| | BOX-LOG today | Action |
|---|---|---|
| Anonymous sign-in, upgrade in place (`updateUser`, same `auth.uid()`) | yes | **keep** (this is the "upgrade without losing data" path) |
| Signup explanation | only "what a circle is" | **add** `signupExplainerHtml` on both pre-signup screens |
| Password rules (10 chars) | yes (`passwordRuleError`, server `passwordOk`) | **keep** |
| Reset | recovery code + owner one-time code, Turnstile | **keep**. See "Brevo" below |
| Persistent session | `persistSession`, `autoRefreshToken` | **keep** |
| Logout | this device | **add** "יציאה מכל המכשירים" (`signOut({scope:'global'})`) |
| TOTP enrol / verify / disable | none | **add** `src/community/mfa.js` |
| aal2 enforcement | none | **add** migration `202611070002_mfa_aal2.sql` (more than Home: the database enforces it) |
| Lost authenticator | none | **add** Edge Function `mfa-recovery` (recovery code) |
| Recovery-code rotation at aal1 | open | **change**: `issue-recovery-code` refuses an aal1 session of a member with TOTP |
| Design / copy / brand | own tokens, palettes | **keep**, nothing copied from Home |

### Brevo
The request assumed a reset email sent via Brevo. BOX-LOG has none: no Brevo code, secret or workflow, and members have
only a synthetic `@members.haimuniya.invalid` address, with "never store member email" a hard rule. An email reset would
need real addresses, a new data field and a sender account. **Not added.** The recovery code stays the reset path
(same as Home's no-email design). To add email later, that is a product decision, not a port.

## 3. What shipped

- `src/community/mfa.js`: code gate, enrol (QR + key), disable (current code), sign out everywhere, recovery via code.
- `supabase/migrations/202611070002_mfa_aal2.sql`: `aal_satisfied()`, `is_community_member()` requires it, restrictive `aal2_required` on every table with a client policy.
- `supabase/functions/mfa-recovery` (+ `_shared/mfa-recovery.mjs`), `issue-recovery-code` aal guard.
- `set-auth-config` workflow also turns TOTP on (hosted), `config.toml` for local.
- Tests: `test/mfa-two-step-login.test.mjs`, `test/mfa-recovery-edge-function.test.mjs`, `supabase/tests/0148_mfa_aal2_test.sql`.

## 4. Limits worth knowing

- Definer RPCs that gate on `auth.uid()` alone (not `is_community_member()`) are not blocked at aal1. A password-only
  session of a member with TOTP can still call those few (own-profile style) functions. New tables need the policy
  (pgTAP 0148 fails otherwise).
- Recovery code removes TOTP, so the code is as strong as the second factor. It is 80 bits, rate limited 5 per 15 min.
