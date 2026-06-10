# Instagram Profile Scraper — Extract Public Posts & Analytics

> Scrape public Instagram profiles, bios, follower stats, and posts. Export structured JSON for influencer research, brand monitoring, and content strategy.

---

## What It Does

This Apify Actor scrapes publicly available Instagram profiles and their posts using a headless browser. It extracts comprehensive profile data including follower counts, bio text, verification status, and business account info. For each profile, it also scrolls through and captures individual posts with captions, hashtags, mentions, engagement metrics, and media metadata.

**No login required.** Only public profile data is accessed.

---

## Features

- Extract full profile data: username, full name, bio, followers, following, posts count, profile image, verified status, business info, external link
- Scrape up to N posts per profile (configurable)
- Captures post type (image, video, carousel, reel), caption, hashtags, mentions, likes, comments, views, timestamps
- Detects sponsored posts and product tags
- Skips private profiles gracefully with warning logs
- Deduplicates posts by post ID
- Saves profiles and posts to separate datasets
- PPE (Pay Per Event) billing: $0.005 per profile scraped
- Residential proxy rotation for anti-bot protection
- Session pool with max 10 uses per session
- Random delays (2–6 seconds) between requests
- 3 retries with retry-on-blocked enabled

---

## Use Cases

1. **Influencer Research** — Analyze follower counts, engagement rates, and content themes for influencer marketing campaigns
2. **Brand Monitoring** — Track what public figures and competitors are posting about your brand or industry
3. **Competitor Analysis** — Benchmark your Instagram performance against competitors' public profiles
4. **Social Media Reporting** — Build automated reports with structured post data for clients or internal dashboards
5. **Content Strategy** — Study top-performing posts, hashtag trends, and posting patterns to inform your content calendar

---

## Pricing

| Event | Price | Description |
|-------|-------|-------------|
| Profile Scraped | $0.005 | Per profile including all posts for that profile |

Apify platform costs (compute, proxy, storage) apply separately. This Actor uses pay-per-event billing so you only pay for successful scrapes.

---

## Sample Output

### Profile Record

```json
{
  "username": "natgeo",
  "fullName": "National Geographic",
  "bio": "Experience the world through the eyes of National Geographic photographers.",
  "followers": 283000000,
  "following": 162,
  "postsCount": 29500,
  "profileImageUrl": "https://scontent.cdninstagram.com/...",
  "isVerified": true,
  "isBusinessAccount": true,
  "businessCategory": "Media/News Company",
  "externalLink": "https://www.nationalgeographic.com",
  "profileUrl": "https://www.instagram.com/natgeo/",
  "isPrivate": false,
  "scrapedAt": "2026-06-09T12:00:00.000Z"
}
```

### Post Record

```json
{
  "postId": "C1234567890",
  "postUrl": "https://www.instagram.com/p/C1234567890/",
  "postType": "image",
  "caption": "Exploring the depths of the ocean reveals creatures never seen before...",
  "hashtags": ["#ocean", "#marinebiology", "#explore"],
  "mentions": ["@jacques_cousteau"],
  "likesCount": 850000,
  "commentsCount": 4200,
  "viewsCount": null,
  "postedDate": "2026-06-08T14:30:00.000Z",
  "thumbnailUrl": "https://scontent.cdninstagram.com/...",
  "locationTag": "Pacific Ocean",
  "isSponsored": false,
  "productTagsFlag": false,
  "username": "natgeo",
  "scrapedAt": "2026-06-09T12:00:05.000Z"
}
```

---

## Input Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `usernames` | `string[]` | required | Instagram usernames or profile URLs |
| `maxPostsPerProfile` | `integer` | `12` | Max posts to scrape per profile (0 = profile only) |
| `includeReels` | `boolean` | `true` | Include Instagram Reels |
| `includeCarousels` | `boolean` | `true` | Include carousel posts |
| `proxyConfiguration` | `object` | Apify Residential | Proxy settings |

---

## Ethics & Legal

This Actor accesses **only publicly available data**. It does not attempt to log in to any account, bypass authentication, or access private content. Users are responsible for complying with Instagram's Terms of Service and applicable laws when using scraped data. Do not use this tool for spam, harassment, or any unlawful purpose.

---

## Requirements

- Apify account
- Residential proxy (recommended, included with Apify plans)
- 4 GB memory allocation
