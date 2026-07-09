# YouTube API Services Compliance — Written Response & Reply Draft

This file contains (1) an important accuracy note, (2) the written answers to attach or paste into
your reply, and (3) a ready-to-send reply email draft. Pair it with the recorded screencast
(`SCREENCAST_SCRIPT.md`).

---

## 1. IMPORTANT — read before you reply

Google's email asks you to demonstrate how the system **"verifies scorekeeper access through live
chat."** That describes an **older version** of ScoreCheck. That live-chat verification feature has
been **removed** — scorekeepers now simply enter a display name in our web app; access is managed
inside the app, not through YouTube chat.

Your **actual, current** use of the YouTube Data API is the **live-chat monitoring dashboard**: your
server reads the public live chat of your *own* concurrent live broadcasts and aggregates the
messages into one operational window (for your broadcast team, commentators, and on-site announcer).

**Do not** claim or demo chat-based verification — it no longer exists, and demonstrating a removed
feature would fail the review. The reply below **accurately** restates your use case as the
monitoring dashboard. This is honest, compliant, and easy to demonstrate. If Google's records still
list the old "verification" use case, the reply politely corrects it.

---

## 2. Written answers (attach or paste into the reply)

**A. API Client / Application name.** ScoreCheck, operated by Beach Volleyball Media
(`score.beachvolleyballmedia.com`).

**B. What the application does (overview).** Beach Volleyball Media live-streams beach volleyball
tournaments on YouTube, frequently running 6–8 simultaneous live broadcasts (one per court). Live
scores shown on the broadcasts are produced by our own web application and data sources (not the
YouTube API). Our **only** use of the YouTube Data API is to read the public live-chat messages from
our own live broadcasts and display them, tagged by court, in a single password-protected monitoring
dashboard used by our production staff, commentators, and on-site announcer.

**C. YouTube Data API methods used.**
- `youtube.videos.list` (part=`liveStreamingDetails`) — to resolve each of our own live broadcasts'
  `activeLiveChatId` from its video ID. Read-only.
- `youtube.liveChatMessages.list` — to retrieve the public live-chat messages for those live chats,
  using pagination tokens for incremental polling. Read-only.
- No write, insert, update, delete, upload, or moderation methods are used. We never post messages,
  modify content, or take moderation actions via the API.

**D. Scopes / auth.** Read-only. We access only live broadcasts owned by our own YouTube channel.
(If using OAuth: `https://www.googleapis.com/auth/youtube.readonly`. Public live-chat reads may also
be performed with an API key.)

**E. How data is used, displayed, and retained.** Retrieved chat messages (author display name,
message text, timestamp, and the message/court association) are shown in real time in an internal,
password-protected monitoring dashboard so our team can respond to operational feedback during a
broadcast (for example, a viewer reporting a camera issue on a specific court). Messages are stored
only transiently to power the live dashboard for the duration of the event and are not sold, shared
with third parties, used for advertising, or used to build user profiles. Access to the dashboard is
restricted by a passcode and is limited to our production team, commentators, and announcer.

**F. Why a quota increase is needed (justification).** During an event we monitor up to **8**
concurrent live chats for the full duration of the tournament day (~10 hours). `liveChatMessages.list`
costs ~5 quota units per call. Even polling each chat only every few minutes, 8 concurrent chats over
a 10-hour day exceeds the default 10,000 units/day. We poll strictly read-only and only our own
broadcasts. A quota increase lets us monitor all live courts at a cadence that makes operational
feedback timely. *(State the specific daily unit amount you requested in the quota form here.)*

**G. Compliance.** We use the YouTube Data API in read-only fashion, only against our own live
broadcasts, solely to display public chat for internal live-event monitoring. We comply with the
YouTube API Services Terms of Service and the Developer Policies. We do not attempt to replicate
YouTube, do not store data beyond operational need, and do not use the API for verification,
authentication, advertising, or resale.

---

## 3. Reply email draft (edit the bracketed parts, then send)

> Subject: Re: YouTube API Services Compliance Review — Beach Volleyball Media
>
> Hello YouTube API Services Team,
>
> Thank you for the review and for the opportunity to clarify. I'd like to first correct our use-case
> description, then provide the requested demonstration.
>
> **Clarification of our use case.** An earlier description of our application referenced verifying
> scorekeepers through live chat. That feature has since been **removed** from our product.
> Scorekeeper access is now handled entirely within our own web application (a scorekeeper simply
> enters a display name), and it does **not** use the YouTube API.
>
> Our current and only use of the YouTube Data API is a **live-chat monitoring dashboard**: our
> server reads the public live chat of our *own* concurrent live broadcasts (up to eight courts at
> once) and aggregates the messages, tagged by court, into a single password-protected window used by
> our broadcast team, commentators, and on-site announcer to respond to viewer feedback during the
> event (for example, a report that a specific court's camera is out of focus).
>
> **API methods (read-only):** `videos.list` (to resolve each live broadcast's active live-chat ID)
> and `liveChatMessages.list` (to read public chat messages). We do not post, modify, delete, or
> moderate any content via the API, and we read only our own broadcasts.
>
> **Screencast demonstration:** [PASTE UNLISTED YOUTUBE OR DRIVE LINK HERE] — a step-by-step English
> walkthrough showing our live broadcasts, how live scores are produced and displayed on the
> broadcast (for context; this does not use the YouTube API), and our live-chat monitoring dashboard
> reading and aggregating the public chats of our concurrent live broadcasts by court.
>
> **Written details:** I've included answers covering the API methods, scopes, data handling and
> retention, and our justification for the requested quota increase. [Either paste section 2 above
> into the email body, or attach it.]
>
> **Quota requested:** [state the daily unit amount you requested] to allow monitoring of up to eight
> concurrent live chats for the ~10-hour duration of an event.
>
> Please let me know if any further information would help complete the review. This is the correct
> API contact for us. Thank you.
>
> Best regards,
> Nathan Hicks
> Beach Volleyball Media
> [phone / channel URL if you wish to include]

---

## 4. Practical next steps
1. Deploy the chat monitor (`/chat`) and set each live court's YouTube video ID in `/admin/production`.
2. On an event day, record the screencast per `SCREENCAST_SCRIPT.md`; upload it unlisted.
3. Fill the bracketed parts of the reply (screencast link, requested quota amount), paste in the
   written answers (section 2), and send.
4. Until the increase is granted, the chat monitor runs in throttled mode (polls each court every
   ~3 minutes) so it stays within the default free quota. Once granted, lowering
   `YOUTUBE_CHAT_POLL_INTERVAL_MS` brings it toward real time — no code change.
