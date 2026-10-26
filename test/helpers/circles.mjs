// Fixtures for the circles tests: a stubbed Supabase client (the shared
// in-memory one, with the Circles RPCs registered on it) and a member who is
// already in one or two circles. Everything runs against the real index.html,
// app.js and cloud.js through test/helpers/boot.mjs; only the network is fake.
import { createMockSupabase } from "./mockSupabase.mjs";
import { bootCommunity, waitFor } from "./boot.mjs";

export const ME = "11111111-1111-4111-8111-111111111111";
export const FRIEND = "22222222-2222-4222-8222-222222222222";
export const FRIEND2 = "33333333-3333-4333-8333-333333333333";
export const CIRCLE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CIRCLE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const TOKEN = "ab".repeat(32);

export function club(over = {}) {
  return Object.assign({
    id: CIRCLE_A, name: "החבר'ה", type: "friends", emoji: "🔥", mode: "together",
    benchmark_enabled: false, invite_policy: "owner", welcome_line: "", benchmark: null, benchmark_month: null, created_by: ME,
  }, over);
}
export function membership(clubOver = {}, over = {}) {
  const c = club(clubOver);
  return Object.assign({ club_id: c.id, user_id: ME, role: "owner", joined_at: "2026-10-01T00:00:00Z", share_defaults: {}, clubs: c }, over);
}

/**
 * A mock with a signed-in, recovery-verified member in the given circles, and
 * the circle RPCs answering from simple in-memory fixtures. `opts.rpc` can
 * replace any handler.
 */
export function createCirclesMock(opts = {}) {
  const mock = createMockSupabase();
  const circles = opts.circles || [membership()];
  mock.db.circle_members = circles.slice();
  mock.db.profiles = [
    { id: ME, handle: "member_me", display_name: "אני", emoji: "💪", recovery_verified_at: "2026-10-01T00:00:00Z" },
    { id: FRIEND, handle: "dana_k", display_name: "דנה", emoji: "🦁", recovery_verified_at: "2026-10-01T00:00:00Z" },
  ];
  mock.db.member_targets = opts.targets || [];
  mock.db.post_training_partners = opts.tags || [];
  mock.db.workout_posts = opts.posts || [];
  mock.db.benchmark_results = opts.benchmarkResults || [];
  mock.feedRows = opts.feed || [];
  mock.weekRows = opts.week || [];
  const h = {
    circle_feed: () => ({ data: mock.feedRows, error: null }),
    circle_week: () => ({ data: mock.weekRows, error: null }),
    toggle_reaction: () => ({ data: true, error: null }),
    mark_recovery_verified: () => ({ data: true, error: null }),
    set_weekly_target: () => ({ data: null, error: null }),
    set_pause: () => ({ data: null, error: null }),
    set_share_defaults: () => ({ data: null, error: null }),
    create_circle: () => ({ data: CIRCLE_B, error: null }),
    update_circle: () => ({ data: null, error: null }),
    create_circle_invite: () => ({ data: TOKEN, error: null }),
    leave_circle: () => ({ data: null, error: null }),
    remove_member: () => ({ data: null, error: null }),
    confirm_trained_together: () => ({ data: null, error: null }),
    post_training_partner_remove: () => ({ data: null, error: null }),
    post_delete: () => ({ data: null, error: null }),
    pr_share: () => ({ data: "post-1", error: null }),
    ach_share: () => ({ data: "post-2", error: null }),
    post_create: () => ({ data: "post-3", error: null }),
    post_training_partners_for: () => ({ data: [], error: null }),
    notif_unread_count: () => ({ data: 0, error: null }),
  };
  Object.assign(h, opts.rpc || {});
  for (const [name, fn] of Object.entries(h)) mock.onRpc(name, fn);
  if (opts.signedIn !== false) mock.setUser({ id: ME, is_anonymous: false });
  return mock;
}

/** Boot, wait for the circle list to load, open the Circle tab. */
export async function bootCircle(mock, bootOpts = {}) {
  const window = await bootCommunity(mock, Object.assign({ syncEnabled: false }, bootOpts));
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityHead") || !!window.document.querySelector("[data-community-action='c-invite-open'], [data-community-action='c-leave-ask']"), 4000);
  return window;
}

export function click(window, selector) {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error("nothing matches " + selector);
  el.click();
  return el;
}
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export { waitFor, bootCommunity };
