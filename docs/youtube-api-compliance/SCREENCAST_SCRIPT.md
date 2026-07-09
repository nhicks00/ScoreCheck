# YouTube API Compliance — Screencast Script (English)

**Purpose:** Google's YouTube API Services Compliance team asked for a complete, step-by-step
screencast demonstrating how Beach Volleyball Media uses the YouTube Data API end-to-end.
Record your screen following the scenes below and narrate the **spoken lines** aloud in English.
Keep it one continuous take if possible (5–8 minutes). Use a real event day so live chats and
live scores are actually flowing.

> **Read the accuracy note in `COMPLIANCE_WRITEUP.md` first.** Your API usage is the **live-chat
> monitoring dashboard**, NOT scorekeeper verification (that was removed). This script demonstrates
> the true current system. Do not demonstrate chat-based verification — it no longer exists.

---

## Before you record (checklist)
- [ ] At least one court is live-broadcasting on your YouTube channel (ideally several).
- [ ] Each live court's YouTube **video ID** is set in the admin at `/admin/production`.
- [ ] The chat monitor at `/chat` is deployed and its passcode is set.
- [ ] Have these tabs ready: your YouTube channel/live broadcasts, `score.beachvolleyballmedia.com`,
      the `/chat` monitor, and `/admin/production`.
- [ ] Screen-recording tool ready (QuickTime, OBS, or Loom). Enable microphone for narration.

---

## Scene 1 — Who we are and what the API does (15–20s)
**On screen:** Your YouTube channel page showing multiple simultaneous live beach-volleyball broadcasts.

**Say:**
> "This is Beach Volleyball Media. We live-stream beach volleyball tournaments on YouTube — often
> six to eight courts at the same time, each on its own live broadcast. Our application uses the
> YouTube Data API for one purpose: to read the public live-chat messages from our own live
> broadcasts and combine them into a single monitoring window, so our broadcast team, commentators,
> and on-site announcer can watch viewer feedback across every court from one place."

## Scene 2 — The live broadcasts (20s)
**On screen:** Open one court's live broadcast on YouTube. Show the video with the on-screen
scoreboard overlay, and the live chat panel on the right.

**Say:**
> "Here is one of our live court broadcasts. Notice the live scoreboard graphic on the video, and
> the YouTube live chat on the right where viewers comment in real time. During an event we have
> several of these running at once, each with its own chat."

## Scene 3 — How scores get onto the broadcast (45s)
**On screen:** Go to `score.beachvolleyballmedia.com`. Pick a court. Enter a display name. Show the
big +/- scoring controls. Add a couple of points.

**Say:**
> "Scores come from our own web application. A community scorekeeper opens our site, chooses the
> court they are watching, enters a display name, and keeps score using these controls. This does
> not use the YouTube API — scorekeeper access is managed entirely inside our web application. I'm
> mentioning it only to show the full picture of the broadcast."

**On screen:** Switch back to the YouTube broadcast (or the overlay page) and show the scoreboard
graphic updating to reflect the points you just entered.

**Say:**
> "The points I just entered flow to the scoreboard graphic on the live broadcast within a couple of
> seconds. That is the end result viewers see."

## Scene 4 — The YouTube API in action: the unified chat monitor (90s) — THE CORE
**On screen:** Open `/chat`, enter the passcode, and show the unified chat window with messages
arriving from multiple courts, each tagged with its color-coded court badge.

**Say:**
> "This is where we use the YouTube Data API. This is our live-chat monitoring dashboard. It is
> password-protected and used by our broadcast operators, commentators, and on-site announcer.
> Behind the scenes, our server calls the YouTube Data API — specifically `videos.list` to find each
> live broadcast's active live-chat ID, and `liveChatMessages.list` to read the public chat messages.
> It reads only our own broadcasts' chats. Every message is tagged with the court it came from."

**On screen:** Point out the court badges. Scroll the feed. Demonstrate the court filter chips and
the "streams currently live" indicator.

**Say:**
> "Each message shows which court and stream it came from. The dashboard automatically knows which
> broadcasts are currently live — if only six of eight courts are streaming, it shows those six. I
> can filter to a single court, or search the messages. This is essential for operations: when a
> viewer types something like 'the camera on court three is out of focus,' our team instantly sees
> which stream it refers to and can fix it."

## Scene 5 — Why we need more quota (30s)
**On screen:** Optionally show a simple note or the `/admin/production` court list with video IDs set.

**Say:**
> "Because we monitor up to eight live chats simultaneously for the full length of an event —
> around ten hours — polling each chat often enough to be useful exceeds the default ten-thousand-
> unit daily quota. That is why we are requesting a quota increase. We poll read-only, we only read
> our own broadcasts, we do not post, modify, or delete anything, and we display messages solely for
> live operational monitoring."

## Scene 6 — Compliance summary and end result (20s)
**On screen:** Show the chat monitor one more time with live messages and court badges.

**Say:**
> "To summarize: we use read-only YouTube Data API calls — `videos.list` and `liveChatMessages.list`
> — to aggregate the public live chats of our own concurrent live broadcasts into a single
> monitoring dashboard for our production team. We comply with the YouTube API Services Terms and
> Developer Policies. Thank you for reviewing our request."

---

## Recording tips
- Speak clearly; keep each scene's actions unhurried so reviewers can follow.
- If chats are quiet during recording, it's fine — the point is to show the mechanism, the court
  badges, and the multi-stream aggregation.
- Export at 1080p, upload as **unlisted** to YouTube (or a shared Drive link) and paste the link in
  your reply. Reviewers accept unlisted links.
