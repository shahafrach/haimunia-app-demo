# Support: פנייה

There is no support email and no phone number (owner decision 2026-10-28).
A member opens **אני** and taps **פנייה**, writes a message, and sends it.

- The message goes to the `bug_reports` table through `bug_report_submit`.
  Stored: the message (up to 4000 characters), the app version, the account
  that wrote it, the time. Nothing about the device, nothing from the training log.
- At most 5 per hour per member.
- The table has no client access. **You read it in the Supabase dashboard**:
  Table Editor, `bug_reports`, newest first. `reporter_id` is the member's
  user id; look it up in `profiles` for the handle and display name.
- Requests for access to a member's data, or for deletion, arrive the same
  way (privacy.html and PRIVACY.md say so). Answer in the circle's WhatsApp
  chat, or delete the account from the dashboard (Authentication, Users).
- Set `status` to `resolved` when done. When a member deletes their account,
  their message text is replaced and the link to them is cut.
