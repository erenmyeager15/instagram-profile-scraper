# Instagram Profile Scraper - Public Profile Analytics

Collect structured metadata and statistics from public Instagram profiles for creator research, brand monitoring, and market analysis.

This repository includes the watchlist upgrade. Apify's selected build may differ from this branch; check its version before relying on optional features. Local tests alone do not establish live source availability or profitability.

The Actor uses bounded HTTP sessions with Residential proxy rotation. It returns one billed row per successfully saved, confirmed public profile. Optional recent-post analytics and watchlist comparisons are included in that row, not billed as separate posts.

## What It Extracts

- Username, full name, biography, and profile URL
- Followers, following, and total post count
- Verification and business-account signals
- Business category and public external link
- Profile image URL and privacy status
- Collection timestamp
- All available published bio links (up to 10), normalized destination URL strings and domains
- Exact / rounded / unknown precision per follower, following and post count; missing fields remain `null`
- Optional recent-post sample (up to 12) with likes, comments, post mix, latest-post date and sample engagement
- Optional named watchlist: comparable follower/following/post-count changes, bio/link changes and a follower-change threshold flag

## Pricing

Each successfully saved public profile costs **$0.002** ($2/1,000). Actor start is **$0.00005** per GB, minimum one event. Platform usage is included; there is no extra charge for nested sample posts, activity summaries or watchlist comparisons. A one-profile run is approximately **$0.00205** in listed event fees at 256 MB.

Failed, blocked, private, privacy-unconfirmed, unavailable and unsaved profiles do not trigger `profile-scraped`. The start fee still applies. Repeated successful checks are billed even when unchanged. A user spending limit stops work before another profile request whenever no result can be charged; it is not a guarantee that already incurred platform usage is zero.

## Input

```json
{
  "usernames": ["natgeo", "https://www.instagram.com/instagram/"],
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

A run accepts up to 50 unique usernames or profile URLs. Residential proxy rotation is the default when omitted; explicit no-proxy or custom proxy settings remain supported but can be blocked. No paid third-party API, login, browser or media download is required.

### Optional creator/brand watchlist

```json
{
  "usernames": ["natgeo"],
  "includeRecentPosts": true,
  "maxRecentPosts": 6,
  "monitorStoreName": "brand-watchlist",
  "followerChangeThresholdPercent": 5,
  "maxRunSeconds": 240
}
```

Reuse the same history name in scheduled runs. The first successful check is `FIRST_SEEN`; later checks compare against the last successfully saved observation. `CHANGED`, `UNCHANGED` and `NOT_COMPARABLE` make coverage explicit. Failed, private or missing targets are never interpreted as follower losses or deletions. Rounded counts, missing fields, changed profile IDs and non-forward timestamps cannot create precise numerical growth claims.

History uses only the run initiator's account storage, with no developer-owned token. It is bounded to 500 profiles, 10 observations per profile, 2 MB serialized state and a 30-day comparison window, and has a writer lock. Old observations are evicted when size bounds are reached, so a later check may be `FIRST_SEEN` again. Retention pruning runs on successful checks, not in a background deletion job; delete the named store if you want history removed while not running the Actor. Do not overlap schedules sharing a name. Blank `monitorStoreName` disables persistent history. History is advanced only for saved rows after report export; an ambiguous history-write timeout is reported as `historyCommitted: "unknown"`, not as a rollback.

`OUTPUT` in the run's key-value store contains lookup status per handle, actual HTTP request count, saved/invalid/duplicate counts, changed-profile records and history commit status. Statuses include `PRIVATE`, `UNAVAILABLE`, `BLOCKED`, `NO_DATA`, `PRIVACY_UNKNOWN`, `TIME_LIMIT` and `BUDGET_LIMIT`. The dataset contains successful profile rows only, not paid error rows.

Each lookup also includes bounded request-stage traces: attempt, HTTP status when available, decoded body size, content kind, a redirect category and a safe timeout/network/size-error code. Raw bodies, cookies, proxy credentials and redirect URLs are not retained in these traces. The profile-page and optional metadata request reuse one generated browser identity per session.

The dataset also defines **Comparable Watchlist Changes** and **Recent-Post Sample Analytics** views. Choose the relevant view for flat table/CSV columns, or use the full JSON for nested sample posts. Enable the matching optional input first; an empty optional column does not mean a zero measurement. A change threshold produces a field flag, not an automatic email or notification.

### Interpreting recent-post analytics

`includeRecentPosts` is off by default. When enabled, the Actor uses only posts already exposed by the public profile response (default cap 6, maximum 12). It does not scroll or fetch every post/Reel.

- Average likes/comments and median interactions use only sampled posts with both counts exposed. Missing or hidden counts are `null`, never assumed zero.
- Engagement percentage is mean `(likes + comments) / exact current followers * 100`. It is a sample-based estimate, not reach, impressions, verified audience quality, a fake-follower score, or an all-time rate.
- `samplePostsPerWeek` is an interval rate within the dated sample, not a complete posting calendar. Pinned posts or incomplete samples can distort it.
- An empty sample is `NOT_EXPOSED`, not proof that the account is inactive. Latest-post date and days since that date refer to the sample only.
- Bio-link domains are parsed from the published URLs, including decoding Instagram's link wrapper. External websites and link-in-bio pages are not visited or verified.

## Illustrative Core Output

This example shows the record shape, not a new owner/customer test or current National Geographic counts. Additional precision/link fields appear on every row; activity and changes appear only when enabled.

```json
{
  "username": "natgeo",
  "fullName": "National Geographic",
  "bio": "Experience the world through the eyes of National Geographic photographers.",
  "followers": 280000000,
  "following": 150,
  "postsCount": 32000,
  "isVerified": true,
  "isBusinessAccount": true,
  "businessCategory": "Media/news company",
  "externalLink": "https://www.nationalgeographic.com/",
  "profileUrl": "https://www.instagram.com/natgeo/",
  "isPrivate": false,
  "scrapedAt": "2026-08-09T10:00:00.000Z"
}
```

## Reliability and Cost Controls

1. Usernames and URLs are normalized and deduplicated.
2. A public HTTP session loads the profile. Complete public structured HTML avoids a second metadata request. The optional public logged-out metadata endpoint is tried only after a successful page response, using the same browser identity, proxy and scoped cookie jar.
3. A refused (403), transient or no-data page can use at most one fresh session. A 401, 429, login/challenge redirect, private or unavailable response ends the lookup without session rotation. Only one safe HTTPS redirect to the same profile is allowed per session; other profiles, external hosts, login pages and loops are not followed. The total ceiling remains four HTTP requests per handle, including redirects.
4. No browser, media download, login, or private endpoint is used.
5. Memory defaults to 256 MB. Source responses are capped at 3 MB, concurrent source requests at one, and source runtime defaults to a soft 240-second limit (30-840 seconds configurable). Reporting/history cleanup takes additional time. Large or blocked batches can be partial.
6. The run fails clearly when no valid public profile is returned.
7. An optional endpoint timeout or invalid JSON cannot discard a usable confirmed-public HTML profile. Wrong-username responses are rejected. Private and privacy-unconfirmed records are not saved or charged.
8. Existing core keys are preserved, but unknown follower/following counts and verification/business flags now use `null` rather than an invented zero/false. Consumers must support nullable fields.
9. Non-success response bodies are discarded after headers instead of being downloaded for parsing. `OUTPUT.lookups[].traces` records safe request stages/statuses and `bodyDiscarded`; `bodyBytes` measures retained body bytes, **not billable proxy transfer**. Packets already in transit and upstream proxy buffering can still incur costs.
10. After two consecutive source-blocked targets, the remaining watchlist is skipped and marked `SOURCE_BLOCKED` with zero attempts/requests. A run with saved rows is partial; one with no saved rows fails visibly. Skipped targets are not billed results or history observations. A non-blocked lookup resets this counter.

## Limits

This is a focused public-profile watchlist, not an exhaustive Instagram crawler. No follower lists, comments pagination, Stories, full post history, About-this-account lookup, personal email/phone extraction, audience demographics, impressions or reach are provided. Instagram may block or withhold all data, even with Residential proxies. Public source changes can still cause failures; no universal success or profit guarantee is made.

## Responsible Use

- Public profiles only; private or login-protected data is not accessed.
- Do not use the Actor for harassment, sensitive-person profiling, deceptive outreach, or attempts to identify private individuals.
- You are responsible for following applicable laws, Instagram's terms, and Apify's platform rules.

## License

Apache-2.0
