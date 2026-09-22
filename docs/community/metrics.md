# Community metrics

The one place that says what the community measures, what each tracked event
means, and where it fires from. COMM-013 shipped the helper, COMM-170 wired
the Phase 1 surfaces, COMM-233 wired the Phase 2 ones. The eleven-module pass
added fourteen more names: one each for the eleven `club_features` keys that
had a switch, a surface and no event at all, plus `app_opened`,
`push_permission` and `push_self_test`. `EVENTS` holds 42 names.

Owner: platform. A feature agent that adds a surface adds a row to the table
below in the same change.

## How an event is recorded

- `window.analyticsTrack(name, props)` from `src/analytics.js` is the only
  writer of `public.analytics_events` (migration 202608280012).
- `cloud.js` calls `HaimuniaAnalytics.configure({ client, getUserId })` once,
  at the head of the session-ready path in `refreshSession()` and
  `onAuthStateChange`. Before that call `analyticsTrack` is an inert no-op
  that drops the event, so ordering matters: configure runs first.
- Six of the names are not hand-tracked at all. They arrive through the
  product event bus bridge, see "Events that come from the bus" below.
- Nothing awaits an analytics call. A failed write is invisible to the
  member and no call site reads the return value.
- An event recorded offline is queued rather than dropped; see "Offline"
  below.

## Schema and versioning

- `SCHEMA_VERSION` is 1. Every row carries it.
- Adding a prop to an existing event is additive and does not move the
  version. Removing a prop, renaming one, or changing what an existing one
  means bumps it, so a query can tell the two shapes apart.
- Props are trimmed, never rejected. Over `PROPS_BUDGET_BYTES` (3 KB) the
  largest values are dropped first and `_truncated: true` is added. The
  server trigger rejects over 4 KB.
- Props carry ids, enums, counts and booleans only. No display name, no
  handle, no caption, no comment body, no report note. The bus bridge
  enforces this with a per-event key allow-list, `BUS_PROP_KEYS`, so a
  producer that widens its payload cannot widen the analytics row.
- COMM-233 added the same enforcement for the hand-tracked Phase 2 events:
  `HAND_PROP_KEYS` in `src/analytics.js` lists the props each of those names
  may carry, and `track()` drops anything else before the row is built. That
  is what makes "a challenge's rules text, a recap sentence, or the search
  query" impossible rather than merely avoided by hand at each call site.
  The Phase 1 names have no entry and pass their props through untouched:
  narrowing an event already in the table is the kind of change
  `SCHEMA_VERSION` exists to make visible, and their call sites are pinned
  by `test/community-analytics-surfaces.test.mjs` instead.

## The dev switch

Set `window.HAIMUNIA_ANALYTICS_DEBUG = true` from a console, or pass
`configure({ debug: true })`. Every tracked event is then logged to the
console and nothing is written. The global wins over the configure option,
which is what makes it usable on a device that is already running. Unset it
to go back to writing.

## Offline

An event recorded with no connection is **queued, not dropped**.

It used to be dropped: `analyticsTrack()` did a direct
`client.from("analytics_events").insert(row)` ending in `.catch(() => false)`,
so offline the fetch rejected and the row was gone. That is defensible for a
lost packet and indefensible as the offline story of an offline-first app — a
member who trains in a basement with no signal, logs the session there and
syncs on the way home was missing from every number this table feeds, and
`attendance_recorded`, the one event that can make somebody WCAM-active
without ever opening the Community tab, is the event most likely to be
recorded with no signal.

The row now rides the existing community outbox (`src/outbox.js`) as a
**silent row**: persisted in IndexedDB, drained on the same reconnect a
member's own queued writes use, and attributed to the member who was offline
rather than to whoever happened to drain it.

`navigator.onLine === false` skips the request entirely; otherwise the insert
is attempted first and the row is queued on a rejection or an error, because
`onLine` is a reliable **no** and an unreliable yes. The `HAND_PROP_KEYS`
projection runs before the queue, so a queued row can never carry more than a
sent one.

A silent row opts out of the three behaviours the outbox has for member
**writes**, each of which would be wrong for telemetry:

1. **It never becomes `failed`.** A row that exhausts its five attempts, or
   hits a permanent error, is deleted. `analyticsTrack()`'s contract is that a
   failed write is invisible and a dropped row is acceptable; a measurement
   sitting in a member's "these did not send" list with a Retry button beside
   it would be a bug in both directions. `pendingCount()`, `failedCount()` and
   `state.outbox` all exclude silent rows.
2. **It never stops the drain.** The FIFO stop-on-first-not-ready rule exists
   so a comment cannot land before its post. Analytics has no such causal
   chain, and a backed-off telemetry row holding up a real post would turn a
   measurement into an outage.
3. **It is capped**, at 200, oldest-first. `post_impression` fires once per
   card per feed session, so browsing a cached feed offline can mint rows by
   the hundred. A member's own queued write is never trimmed to make room —
   the same trade `fitProps()` already makes for oversized props.

The misattribution guard is unchanged: a silent row queued under one member's
session is skipped, never sent, if a different member is signed in when the
queue drains.

If the queue is unavailable or throws, the behaviour degrades to what it was —
the row is dropped — because a measurement must never be able to break the
surface it measures.

## Weekly Community Active Members (WCAM)

Spec section 78. The core community health metric. One agreed definition, so
the client event stream and any later server-side rollup cannot disagree.

WCAM for a calendar week is the count of unique members who, inside that
week, did at least one of:

- created a post
- created a comment
- added a reaction
- joined a challenge
- participated in an event (an RSVP of going, or attending)
- shared an achievement
- interacted with a coach or with a community item (opened a post, opened a
  member profile, opened an announcement, opened a notification)
- shared a weekly recap figure, or, as a coach, sent a congratulation from
  the Coach Dashboard

Passive views alone do not count. Opening the club tab or scrolling the feed
is not membership activity. Uniqueness is per member per week, not per
action, so ten comments from one member is one active member. Week
boundaries follow the club's local week, not UTC.

COMM-233 reviewed each Phase 2 name against this bar one at a time rather
than letting a new event default in or out:

- `challenge_joined`, `challenge_completed` and `event_rsvp` count. They
  were already qualifying activity types here; Phase 2 only gave them real
  producers.
- `coach_congratulate_sent` counts, **for the coach**. The row's `user_id`
  is the actor, so the celebrated member is never made active by somebody
  else's action - they become active when they answer it, through their own
  `comment_created` or `reaction_added`.
- `weekly_recap_shared` counts, on the same reading as `achievement_shared`
  already in the list: a share is a post the member published.
- `leaderboard_viewed`, `weekly_recap_opened`, `search_performed` and
  `directory_opened` do not. Viewing is not the bar set above; a roster and
  a search box are navigation, not participation. A member who only ever
  browsed the club is not an active member of it.
- `push_opt_in` does not. Changing a notification setting is account
  configuration.

COMM-307 reviewed `classmates_card_viewed` against the same bar and it does
**not** count, on the `leaderboard_viewed` reasoning above. Two things make it
a clearer no than most: the card appearing is not an action the member took -
it is a fact about their training and somebody else's - and the training that
produced it is already counted once, as `attendance_recorded`, so counting the
card too would count one session twice and would also let another member's
session make this member active. Acting *from* the card does count, through
`member_followed` and `profile_opened`, which is where the participation
actually is.

The eleven-module pass reviewed each of its own fourteen new names the same
way and added exactly **two** to the qualifying set:

- `welcome_sent` counts. `welcomeNewMember()` writes a real comment through
  `add_post_comment`, and "created a comment" is the first bullet of the
  definition above. That path bypasses the composer, so no `COMMENT_CREATED`
  bus event is emitted for it — this closes a gap in the existing count
  rather than admitting a new kind of activity. A coach whose only community
  act in a week was welcoming three newcomers was not, until now, an active
  member of their own club.
- `member_of_week_published` counts, **for the publishing coach**, on exactly
  `coach_congratulate_sent`'s reasoning: the row's `user_id` is the actor.
  The recognised member is never made active by somebody else choosing them.

Everything else the pass added does **not** count, each for a stated reason:

- `announcement_viewed`, `monthly_recap_viewed` and `new_member_post_viewed`
  are views, and viewing is not the bar — the same call `leaderboard_viewed`
  and `classmates_card_viewed` already made.
- `club_wod_result_attached` does not: the member is already counted for the
  day they trained, through `attendance_recorded`.
- `post_photo_attached` and `mention_inserted` do not. Both happen inside a
  composer, before anything is published; the publish is `post_created` /
  `comment_created` and already counts. An abandoned draft must make nobody
  active.
- `outward_share_completed` does not. It is a share to somewhere that is not
  this club — the same line the module map already draws between
  `workout_shared` and `outward_share`.
- `streak_nudge_opened` does not: `notification_opened` fires on the same tap
  and already counts that member once.
- `engagement_flag_actioned` does not. Triaging a queue is staff
  administration; the coach becomes active through the outreach post it
  publishes, which `post_created` already counts.
- `app_opened`, `push_permission` and `push_self_test` do not. Opening the app
  is not participation, and a permission or a device test is account
  configuration — `push_opt_in`'s own reasoning, unchanged.

**One clause in the definition above still has no producer.** "Opened an
announcement" is listed as qualifying activity and nothing in this app opens
an announcement: the archive renders every notice inline, and the feed card is
a `POST_ANNOUNCEMENT` like any other post. `announcement_viewed` is not that
clause and is deliberately not counted as it. Either the surface grows an open
or the clause goes; recorded here so the next reader does not assume the event
closed it.

The qualifying event names are `ACTIVE_MEMBER_EVENTS` in `src/analytics.js`,
and `isActiveMemberEvent(name)` answers for one name. They are kept as data
so a rollup query and the client cannot drift apart. The WCAM column in the
table below is the same list in readable form.

Computed from the stored events:

```sql
select count(distinct user_id)
from public.analytics_events
where event_name in (
  'post_created','workout_shared','achievement_shared','comment_created',
  'reaction_added','challenge_joined','challenge_completed','event_rsvp',
  'post_opened','profile_opened','member_followed','notification_opened',
  'weekly_recap_shared','coach_congratulate_sent','attendance_recorded',
  'welcome_sent','member_of_week_published')
  and created_at >= :week_start and created_at < :week_end
  and user_id is not null;
```

The community tables are the cross-check, not the source. `post_comments`,
`reactions` and `workout_posts` hold the same actions with server
timestamps, so a week whose event count and table count disagree by a wide
margin means events were dropped, not that members were inactive.

## Tracked events

WCAM marks the events that make a member active for the week.

| Event | Trigger surface | Props | WCAM |
| --- | --- | --- | --- |
| `write_failed` | `trackWriteFailure()`, after any failed community write in `cloudWrite()`/the outbox handlers | `action` (the action name, 60 chars), `code` (a coarse error code, 20 chars) | no |
| `club_tab_viewed` | `afterRenderCommunity()`, once per entry into a club sub-tab | `tab` | no |
| `feed_viewed` | Entering the Feed sub-tab, and a filter chip change in `setFeedScope()` | `scope`, `source` (`club_tab`, `scope_change`) | no |
| `post_impression` | `noteFeedImpression()`, a card at least half visible for one second | `post_id`, `position`, `feed_session_id` | no |
| `post_opened` | `toggleComments()` on open, the thread is the post detail view in V1 | `post_id`, `post_type`, `source` | yes |
| `post_created` | Bus, `POST_CREATED` | `post_id`, `post_type`, `visibility`, `has_media` | yes |
| `workout_shared` | `publishWorkout()` after the write succeeds | `source_type`, `visibility`, `has_photo` | yes |
| `achievement_shared` | `shareAchievementUnlock()` and `publishAchievement()`, both after the write | `member_achievement_id`, `code`, `source` (`unlock_sheet`, `app_share_button`) | yes |
| `reaction_added` | Bus, `REACTION_CREATED` | `post_id`, `reaction_type` | yes |
| `comment_created` | Bus, `COMMENT_CREATED` | `post_id`, `comment_id`, `parent_comment_id`, `mention_count` | yes |
| `profile_opened` | `viewCommunityProfile()` on open, before the RPC answers | `user_id`, `self` | yes |
| `member_followed` | `follow()` on a new follow edge only | `user_id` | yes |
| `challenge_viewed` | Entering the Boards sub-tab with an active weekly challenge, and every `openChallenge()` | `challenge_id`, `challenge_key`, `source` (`boards`, `post_card`, `search`, `club_top`, `onboarding`) | no |
| `challenge_joined` | Bus, `CHALLENGE_JOINED`, emitted by `joinChallenge()` (COMM-207) | `challenge_id`, `challenge_type` | yes |
| `challenge_completed` | Bus, `CHALLENGE_COMPLETED`, emitted when a member's own progress reaches the target (COMM-207) | `challenge_id`, `challenge_type` | yes |
| `leaderboard_viewed` | Entering the Boards sub-tab (weekly challenge + consistency boards), and the challenge detail's own progress board | `board` (`weekly_challenge`, `consistency`, `challenge_progress`), `rows`, `source` | no |
| `event_viewed` | Every `openEvent()`: the Boards list card, the `POST_EVENT` link card, a search result, the club header, the recap's upcoming event, a notification | `event_id`, `source` | no |
| `event_rsvp` | Bus, `EVENT_REGISTERED`, emitted by `rsvpEvent()` (COMM-214) | `event_id`, `rsvp_status` | yes |
| `notification_opened` | `openNotif()`, before the mark-read await | `notification_id`, `type`, `target`, `was_unread` | yes |
| `report_submitted` | `submitReportSheet()` after the report RPC succeeds | `target_type`, `reason` | no |
| `weekly_recap_opened` | `openRecap()` on open, before the row is fetched. COMM-233's `recap_viewed` | `source` (`account`, `notification`) | no |
| `weekly_recap_shared` | `shareRecapFigure()` after `post_create` succeeds. COMM-233's `recap_shared` | `figure` (`sessions`, `streak`, `pr`, `achievement`), `post_id` | yes |
| `search_performed` | Both search boxes, once per settled search rather than per keystroke | `source` (`community_search`, `directory`), `query_length`, `member_count`, `event_count`, `challenge_count` | no |
| `push_opt_in` | `enableNotifPush()` after the `push_subscriptions` upsert succeeds | `source` (`notif_pref`), `pref_type` | no |
| `coach_congratulate_sent` | `congratulateCelebrateItem()` after the comment or post write succeeds | `kind`, `via` (`comment`, `post`) | yes, for the coach |
| `directory_opened` | Entering the Directory sub-tab | `source` (`club_tab`, `leaderboard`) | no |
| `attendance_recorded` | Bus, `ATTENDANCE_RECORDED`, emitted by `flushOutbox()` after a session-bearing `private_records` upsert succeeds (COMM-300) | `occurred_on` | yes |
| `classmates_card_viewed` | `afterRenderCommunity()`, once per load of COMM-307's trained-with-you card, and only when it renders with at least one classmate on it | `rows`, `source` (`feed`) | no |
| `app_opened` | `ensureAnalyticsConfigured()` in cloud.js, once per page load, on the same session-ready path `configure()` itself runs on | `display_mode` (`standalone`, `browser`), `platform` (`ios`, `android`, `other`) | no |
| `push_permission` | `loadNotifPushStatus()` on the first Account-tab visit (source `account_tab`), and after every `Notification.requestPermission()` (source `prompt`, `self_test`) | `status` (`granted`, `denied`, `default`), `source`, `display_mode` | no |
| `push_self_test` | `runPushSelfTest()`: `received` from the service worker's own receipt, `not_received` from the page's 8-second timeout | `result` (`received`, `not_received`) | no |
| `announcement_viewed` | `afterRenderCommunity()`, once per entry into the Community tab, when the announcements archive is in the document with at least one row on it | `rows`, `source` (`feed`, `staff_home`) | no |
| `member_of_week_published` | `publishMemberOfWeek()` after the RPC succeeds and the envelope has been re-read | `category` (server-resolved), `source` (`candidate`, `manual`) | yes, for the coach |
| `welcome_sent` | `welcomeNewMember()` after `add_post_comment` succeeds | `source` (`feed_card`, `coach_section`) | yes |
| `monthly_recap_viewed` | `afterRenderCommunity()`, once per entry, when the member-facing published monthly card is in the document. Never the staff draft preview | `source` (`account`) | no |
| `club_wod_result_attached` | `attachClubWodResult()` after `club_wod_attach_result` succeeds | `source` (`board`, `log_form`) | no |
| `new_member_post_viewed` | `noteFeedImpression()`, on the same once-per-post-per-feed-session guard, when the impressed card is a `POST_NEW_MEMBER` | `source` (`feed`) | no |
| `post_photo_attached` | `composerAddPhoto()` / `prPromptAddPhoto()`, on the ready branch only — the attach, not the publish | `source` (`composer`, `pr_prompt`), `photo_count` | no |
| `mention_inserted` | `mentionPick()`, when a member picks somebody out of the "@" picker | `source` (`comment`, `reply`) | no |
| `outward_share_completed` | `outwardShareNow()` and `outwardCopyText()`, once the sheet settles | `kind` (`pr`, `achievement`, `workout`), `result` (`shared_image`, `shared_text`, `copied`, `cancelled`, `failed`) | no |
| `streak_nudge_opened` | `openNotif()`, when the opened row's type is `streak_at_risk` | `was_unread` | no |
| `engagement_flag_actioned` | `coachEngageReachOut()` after the outreach post writes, and `coachEngageResolveFlag()` after the status update | `action` (`reach_out`, `reviewed`, `dismissed`), `level` | no |

### Events that come from the bus

`post_created`, `comment_created`, `reaction_added`, `challenge_joined`,
`challenge_completed`, `event_rsvp` and `attendance_recorded` are never
hand-tracked. The bridge in
`src/analytics.js` subscribes to the matching product event and writes the
row, which is what keeps one producer from having to remember two calls. A
second hand-written call at the same surface would double count.

`BUS_PROP_KEYS` projects each payload down to the listed props. A key the
producer sends that is not on the list is dropped, and an array prop named in
`BUS_COUNT_KEYS` is stored as its length. `mentions` on `COMMENT_CREATED` is
the live case: the bus carries the resolved mention objects for the
notification consumer, and analytics keeps only `mention_count`.

`WORKOUT_COMPLETED`, `PR_CREATED`, `MEMBER_JOINED` and
`ACHIEVEMENT_UNLOCKED` are deliberately unmapped. Completing a workout is
not sharing one and unlocking an achievement is not sharing it, so mapping
either would inflate WCAM with actions that are not community
participation.

`ATTENDANCE_RECORDED` was on that list too until COMM-300, for a different
reason: it had no producer at all. It has one now, and it is mapped. The
distinction against `WORKOUT_COMPLETED` is not hair-splitting - one is a
local UI event that fires per logged set, the other is one emit per member
per calendar day, after the record reached the server, which is the same
grain the `attendance_log` table stores.

### Counting once

- `club_tab_viewed` is recorded from `afterRenderCommunity()`, which runs on
  every re-render of the Community tab. The last counted sub-tab is
  remembered, so a re-render of the same one records nothing. Leaving the
  Community tab clears that memory, so returning counts as a new view.
- `post_impression` rides the same `state.feedSeen` guard the COMM-114
  impression pipeline uses, so both are exactly once per post per feed
  session. Two tables, two consumers, one trigger.
- `post_opened` fires on the open branch of `toggleComments()` only. A close
  is not an open.
- `member_followed` fires only when the insert succeeds. The follow control
  toggles, and the duplicate-key branch is an unfollow.
- Every write-backed event is recorded after the write, so a failed action is
  never counted as one. The exceptions are `profile_opened`,
  `notification_opened` and `weekly_recap_opened`, all recorded at the moment
  of the action because the member opened the thing whether or not the fetch
  behind it answers.
- `directory_opened` rides the same once-per-entry guard as
  `club_tab_viewed`, so a page of members arriving or a follow toggling is
  not a second view of the roster.
- `weekly_recap_opened` fires on the open only. Browsing to the previous or
  next week refreshes the same open surface, which is not a new open.
- `search_performed` is debounced by 600 ms, separately from the fetch: both
  boxes issue a request on every keystroke (COMM-228 chose latency over
  batching, and the token guard makes it safe), so tracking the raw call
  would put three rows in the table for a member typing "noam" and turn
  "searches per week" into "characters typed per week". Backspacing under
  the two-character floor cancels the pending row: an abandoned search was
  not a search.
- `coach_congratulate_sent` fires once per celebrate item. The client-side
  `congratulated` set makes a second tap a no-op before the write, so the
  event cannot repeat either.
- `attendance_recorded` is one event per member per calendar day, not per
  logged set. `flushOutbox()` keeps a per-page `(user_id, occurred_on)` set
  and skips a day it has already emitted, mirroring the `(user_id,
  occurred_on)` unique key on `attendance_log`. Three lifts logged on one
  day are one attendance day server-side and one event here. It is emitted
  only after the `private_records` upsert succeeds - a failed sync is not a
  session - and never for a soft-delete.
- `classmates_card_viewed` rides the same once-per-entry guard shape as
  `club_tab_viewed`, keyed to the card's own load rather than to a sub-tab: a
  cheer, a comment arriving over realtime or a photo URL resolving all
  re-render the feed and none of them is a second view. It fires from
  `afterRenderCommunity()` and not from the fetch, because the card only
  exists once it is in the document - a fetch that answered with rows is not
  yet a view. It never fires for an empty or failed `attendance_classmates_today()`,
  since there is no card at all in either case, which means "card impressions"
  and "how often the card had anything to show" are the same number by
  construction. `rows` is a count, never the members: the card's whole content
  is other people's identities and none of it reaches `analytics_events`.

- `announcement_viewed` and `monthly_recap_viewed` ride the same
  once-per-entry guard `club_tab_viewed` uses, and are reset by the same
  capture-phase listener when the member leaves the Community tab. Both
  surfaces render inline rather than opening, so "viewed" means "was in the
  document with content on it", which is a fact only `afterRenderCommunity()`
  can see. Neither fires on an empty surface: the announcements archive emits
  its marker only on the non-empty branch, and the member-facing monthly card
  renders nothing at all until a month is published.
- `new_member_post_viewed` rides `noteFeedImpression()`'s own
  `state.feed.seen` guard, so it is exactly once per welcome card per feed
  session — the same guard, the same moment, one extra row. A second guard
  for the same moment would be two counters that can disagree.
- `post_photo_attached` fires on the ready branch of each composer only, so a
  failed upload is not an attached photo, and it counts **attachments, not
  posts**: three photos on one post are three rows, with `photo_count`
  climbing 1, 2, 3. `post_created.has_media` is the published-side
  cross-check.
- `welcome_sent` cannot repeat. `welcomeNewMember()` returns early for a post
  that already carries the welcome comment, and that early return is above
  the track call.
- `engagement_flag_actioned` is once per flag per action, guarded by the
  in-flight `busy` map and — for a reach-out — by the `reachedOut` set the
  loader reconstructs from `member_contact_log`.
- `outward_share_completed` fires once per settled sheet, from either exit
  (the share button or the copy-text button). `cancelled` is recorded rather
  than dropped: "opened the sheet and backed out" and "never opened it" are
  different findings, and only one of them is about the feature.
- `streak_nudge_opened` is **the one deliberate double in the event set**.
  The same tap also writes `notification_opened`, because the two rows answer
  to different modules — `streak_risk_nudges` and `notifications` — and
  without it a nudge module whose entire client footprint is one notification
  type stays exactly as unmeasurable as it was. Per-module unique-member
  counts stay correct; a sum of `event_count` across modules does not, and
  `docs/audit/usage-queries.sql` never takes one.
- `push_permission` records at most one row per distinct `status|source` pair
  per page load, so the transition a prompt produces (`default` →
  `granted`) is two rows and a re-render of the settings panel is none.
- `app_opened` is once per page load, not per sign-in: `configure()` is
  idempotent and so is the event beside it.

## How the app asks for notification permission

A browser gives a site **one** chance at the permission prompt. A denial is
sticky and there is no API to ask again. So the prompt is not something to
spend early and hope; three conditions must all hold before
`Notification.requestPermission()` is reachable at all
(`pushAskGateReason()`, `src/community/notifications.js`):

1. **A user action.** Every caller passes `userAction: true` and the gate
   refuses without it. "Never on first load" is not a timer — it is the
   absence of any code path that asks without somebody having pressed
   something. The two callers are `enableNotifPush()` (the push channel
   button on a preference row) and `runPushSelfTest()` (the self-test
   button), both click handlers.
2. **Inside the installed app.** `isStandalonePwa()` must be true. On iOS
   this is a hard platform rule — Safari withholds the Push API from a plain
   browser tab — and everywhere else it is a product one.
3. **Earned.** At least one logged workout
   (`window.haimuniaTotalLoggedEntries()`, exported by app.js) or a community
   profile. Before either, "may we interrupt you later" is a question about a
   relationship that does not exist yet.

The iOS install banner carries one line saying notifications need the
installed app, so a member on iOS Safari learns it from the banner rather
than from a control that does nothing. It is in `#iosInstallBanner` only —
`maybeShowIOSInstallBanner()` already shows that banner exclusively on iOS
outside standalone, which is exactly and only the population the sentence is
true for.

## The push self-test

Account settings, under the preference rows: one button per device, because
a `PushSubscription` is per device.

It asks **this device's own service worker** to show a real notification and
waits for the worker to report back that it did. That exercises the four
things that break on a real phone: the permission is granted, a service
worker is registered and controlling the page, the worker can call
`showNotification()`, and the page and the worker can still talk to each
other. It does **not** exercise the push server — `notif_push_pending` and
the Edge Function behind it (202609170002) are a scheduled job measured in
minutes, and a test a member waits five minutes for is not a test. The screen
says so in one line rather than implying more.

The worker draws the notification rather than the page, because every real
push this app delivers is drawn by `sw.js`'s push handler from the worker's
own registration — which is the surface a member who says "I never get
notifications" has a problem with.

**The worker records the receipt; the page writes the row.** A service worker
has no Supabase client and deliberately cannot read `cloud-config.js`, so
`sw.js` posts `PUSH_SELF_TEST_RECEIVED` back to its clients, app.js's existing
`serviceWorker` message listener routes it to
`communityHandlePushSelfTestReceipt()`, and the row goes through
`analyticsTrack()` — the one existing writer of `public.analytics_events`.
The same page-decides split `PUSH_NOTIFICATION_CLICK` has used since
COMM-229. A token travels out and back so a late receipt from an abandoned
run cannot resolve a newer one.

**"Not received" is an answer, and it is the one members arrive for.** After
eight seconds with no receipt the page settles on `not_received`, writes that
row, and tells the member what to check. A test that hangs on a spinner tells
them nothing.

## Core metrics

Spec section 78.

- Weekly Community Active Members, defined above. The headline number.
- WCAM as a share of club members, from `WCAM / count(profiles)` for the
  club in the same week.
- Posting members per week, `count(distinct user_id)` over `post_created`,
  `workout_shared` and `achievement_shared`.
- Engagement per post, `reaction_added` plus `comment_created` over
  `post_created`, in a week.
- Feed reach, `count(distinct post_id)` over `post_impression` against the
  posts published in the window.

## Additional metrics

Spec section 79. Every one of these is answerable from the event set above
plus the community tables, with no new event name.

- Open rate per surface, `post_opened` over `post_impression`, by
  `post_type`.
- Filter use, `feed_viewed` grouped by `scope`, and the share of sessions
  that ever change scope.
- Sub-tab split, `club_tab_viewed` grouped by `tab`.
- Notification effectiveness, `notification_opened` over notifications
  delivered, by `type`, with `was_unread` separating a real open from a
  revisit.
- Social graph growth, `member_followed` per week, and `profile_opened` with
  `self = false` as the discovery signal ahead of it.
- Challenge and leaderboard pull, `challenge_viewed` and
  `leaderboard_viewed` per week, against `challenge_joined` for the
  conversion.
- Moderation load, `report_submitted` grouped by `reason` and
  `target_type`, against the queue in `reports`.
- Share intent split, `workout_shared` by `visibility`, and
  `achievement_shared` by `source`.
- Recap pull-through, `weekly_recap_opened` by `source` against the recap
  notifications sent, and `weekly_recap_shared` over it by `figure`.
- Discovery split, `search_performed` by `source` with `member_count` at
  zero as the "found nothing" rate, against `directory_opened` for how many
  members browse the roster instead of searching it.
- Coach reach, `coach_congratulate_sent` per week by `kind`, against the
  celebrate items the dashboard offered.
- Push adoption, `push_opt_in` per week against the unrevoked rows in
  `push_subscriptions`.
- Trained-with-you reach, `classmates_card_viewed` per week with `rows` as the
  size of the overlap it found, against `attendance_recorded` for the share of
  training days that produced a card at all. A low ratio is `show_attendance`
  adoption, not a broken card: the toggle defaults to false and both sides of
  every pair have to have flipped it. `member_followed` and `profile_opened`
  in the same session are the conversion off it, and neither carries a prop
  saying the card was the source - the card's own event is the denominator.

- Install share, `app_opened` grouped by `display_mode` and `platform`, with
  `count(distinct user_id)` as the member number — never the session count,
  which is visit frequency wearing an install's clothes. A member can appear
  in both display modes legitimately (the installed app on a phone, a browser
  tab on a laptop).
- Push funnel, `push_permission` by `status` → `push_opt_in` →
  `push_self_test` by `result`. The row that is an action item rather than a
  statistic is `self_test_missing` against `permission_granted`: a granted
  permission with no delivery is a broken install, not a preference.
- Module reach for the eleven that used to be silent — one event each, read
  through `docs/audit/usage-queries.sql` queries 2 and 5. Their point is
  negative evidence: a module with a switch, a surface and zero events for
  thirty days can now be discussed, where before the only honest answer was
  "nothing measures it".
- Composer drop-off, `post_photo_attached` and `mention_inserted` against
  `post_created.has_media` and `comment_created.mention_count`. A high attach
  count with a low published rate is a composer problem, not a disused
  feature, and neither number says that alone.

The section 79 list in the product spec was not in this repo when this doc
was written, so the set above is what the shipped event schema supports.
Planner to reconcile the two and add anything missing as an additive prop or
a new constant rather than a rename.

## Closed in Phase 2, COMM-233

Everything the Phase 1 doc listed as parked is now wired, except attendance:

- `weekly_recap_opened` and `weekly_recap_shared` fire from COMM-221's recap
  surface. COMM-233 names them `recap_viewed` and `recap_shared`; the wire
  names stay the two spec 77 reserved, because a second spelling for the
  same two actions would split every recap query for no gain.
- `challenge_joined`, `challenge_completed` and `event_rsvp` have real
  producers now: `joinChallenge()`, the own-progress completion branch
  (COMM-207) and `rsvpEvent()` (COMM-214). Nothing was added to the bridge -
  the bus mapping and the prop shape agreed in Phase 1 were what those
  producers emitted into, and COMM-233 only confirmed the bridge is
  exercised end to end.
- `challenge_viewed` and `event_viewed` now open real detail surfaces
  (COMM-207, COMM-213) and carry the `source` each entry point passes.
- The Boards list cards were recording `source: "post_card"`, because the
  handler's default was written for the link card inside a feed post and the
  list cards carried no `data-source` of their own. Fixed in COMM-233 for
  both challenges and events: any `challenge_viewed` or `event_viewed` with
  `source = "post_card"` dated before that change may actually be a Boards
  open, so a source split across that boundary is not comparable.

## Closed in Phase 3, COMM-300

- Attendance. The line that used to sit under "Still not wired"
  (`ATTENDANCE_RECORDED` has no producer and no analytics name, the source
  is parked under COMM-P03) is closed. The source is a member's own
  session-logging sync: the `private_records_attendance_log` trigger
  (202608310001) derives one `attendance_log` row per member per calendar
  day from the `strength_entry` / `wod_entry` rows the offline outbox
  already upserts, `flushOutbox()` emits `ATTENDANCE_RECORDED` alongside it,
  and `attendance_recorded` is bridged off that emit and counts toward WCAM.
- Two caveats worth carrying into any query written against it. First, the
  emit is a courtesy for client consumers and the analytics bridge - it is
  not what writes `attendance_log`, the trigger is, independently, so
  `analytics_events` and `attendance_log` can legitimately disagree (a
  member on an older cached build produces the table row and no event).
  `attendance_log` is the source of truth for attendance; the event is the
  source of truth for WCAM. Second, "verified" attendance here means
  "derived server-side from the member's own private training log", not a
  physical or staff-confirmed check-in.

## Still not wired

- `post_opened` is not recorded when a notification routes to a post.
  `openNotif()` opens the thread directly rather than through
  `toggleComments()`. `notification_opened` covers that member for WCAM, so
  nothing is lost from the core metric, and the open-rate denominator is
  feed impressions, which that path does not touch either.
