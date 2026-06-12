# Instagram Profile Scraper - Bio, Followers, Stats & Posts

Scrape public Instagram profiles to extract bios, follower and following counts, post counts, verification status, business info, and external links — no login and no API key required. Export to JSON, CSV, Excel, or HTML, or pull via the Apify API. This Instagram profile scraper is fast and reliable for influencer research, brand monitoring, and lead generation, with optional best-effort post scraping.

Built with Node.js, TypeScript, the Apify SDK, and a headless browser. It accesses only public profile data, rotates residential proxies, and retries on blocks so runs stay reliable and repeatable.

## What It Extracts

For each public profile (a Profile record):

- `username` — Instagram handle
- `fullName` — display name
- `bio` — profile biography text
- `followers` — follower count
- `following` — following count
- `postsCount` — total number of posts
- `profileImageUrl` — profile picture URL
- `isVerified` — verified badge status
- `isBusinessAccount` — business/professional account flag
- `businessCategory` — business category label
- `externalLink` — link in bio
- `profileUrl` — canonical profile URL
- `isPrivate` — whether the profile is private
- `scrapedAt` — ISO scrape timestamp

When post scraping is enabled (beta, best-effort), each post is saved as a Post record:

- `postId`, `postUrl`, `postType` (image, video, carousel, reel)
- `caption`, `hashtags`, `mentions`
- `likesCount`, `commentsCount`, `viewsCount`
- `postedDate`, `thumbnailUrl`, `locationTag`
- `isSponsored`, `productTagsFlag`
- `username` and `scrapedAt`

## Use Cases

1. **Influencer research** — Pull follower counts, verification status, and bio details to vet and shortlist creators for marketing campaigns.
2. **Brand monitoring** — Track what public figures and competitor accounts post about your brand or industry.
3. **Competitor analysis** — Benchmark follower growth, posting cadence, and engagement against rival public profiles.
4. **Lead generation** — Build prospect lists from business accounts, capturing category and the external link in bio.
5. **Content strategy** — Study top-performing posts, hashtag trends, and posting patterns to shape your content calendar.

## Pricing

This Actor uses Apify Pay Per Event pricing. You pay only for profiles successfully scraped — blocked or empty results are not billed.

| Event name | Price per event | 1,000 profiles | 10,000 profiles |
| --- | ---: | ---: | ---: |
| `profile-scraped` | $0.002 | $2.00 | $20.00 |

Apify platform costs (compute, proxy, storage) apply separately.

## Input

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `usernames` | string[] | yes | `["natgeo"]` | Instagram usernames (without @) or full profile URLs |
| `maxPostsPerProfile` | integer | no | `0` | Recent posts to scrape per profile (0 = fast, reliable profile-only). Post scraping is best-effort beta, max 500 |
| `includeReels` | boolean | no | `true` | Include Instagram Reels in scraped posts |
| `includeCarousels` | boolean | no | `true` | Include carousel (multi-image/video) posts |
| `proxyConfiguration` | object | no | Apify Residential | Proxy settings. Residential recommended for Instagram |

## How to Scrape Instagram (Step by Step)

1. Click **Try for free** / **Run**.
2. Enter one or more Instagram usernames or profile URLs in `usernames`.
3. Leave `maxPostsPerProfile` at `0` for fast, reliable profile data, or raise it to attempt best-effort post scraping.
4. Keep residential proxies enabled, then click **Start**.
5. When the run finishes, export results as JSON, CSV, Excel, or HTML, or pull them via the Apify API.

## Sample Output

Profile record:

```json
{
  "username": "natgeo",
  "fullName": "National Geographic",
  "bio": "Experience the world through the eyes of National Geographic photographers.",
  "followers": 283000000,
  "following": 162,
  "postsCount": 29500,
  "profileImageUrl": "https://scontent.cdninstagram.com/v/profile.jpg",
  "isVerified": true,
  "isBusinessAccount": true,
  "businessCategory": "Media/News Company",
  "externalLink": "https://www.nationalgeographic.com",
  "profileUrl": "https://www.instagram.com/natgeo/",
  "isPrivate": false,
  "scrapedAt": "2026-06-09T12:00:00.000Z"
}
```

Post record (when post scraping is enabled):

```json
{
  "postId": "C1234567890",
  "postUrl": "https://www.instagram.com/p/C1234567890/",
  "postType": "image",
  "caption": "Exploring the depths of the ocean reveals creatures never seen before.",
  "hashtags": ["#ocean", "#marinebiology", "#explore"],
  "mentions": ["@jacques_cousteau"],
  "likesCount": 850000,
  "commentsCount": 4200,
  "viewsCount": null,
  "postedDate": "2026-06-08T14:30:00.000Z",
  "thumbnailUrl": "https://scontent.cdninstagram.com/v/thumb.jpg",
  "locationTag": "Pacific Ocean",
  "isSponsored": false,
  "productTagsFlag": false,
  "username": "natgeo",
  "scrapedAt": "2026-06-09T12:00:05.000Z"
}
```

## How It Works

1. Validates input and normalizes usernames or profile URLs.
2. Loads each public profile in a headless browser through residential proxies.
3. Extracts profile fields, with field-level fallback to defaults when optional data is unavailable.
4. Optionally scrolls the profile to capture recent posts (best-effort, beta), deduplicating by post ID.
5. Charges `profile-scraped` only after a profile is successfully saved, then writes profiles and posts to the Apify Dataset.

## Known Limits

- Only public profiles are accessible. Private profiles are skipped gracefully with a warning.
- Post scraping is best-effort beta and may be limited by Instagram's logged-out restrictions; `viewsCount` and some post fields can be `null`.
- Instagram layout changes and rate limits can affect availability of optional fields.
- Residential proxies are strongly recommended for consistent results.

## Legal and Ethical Use

This Actor accesses only publicly available data. It does not log in, bypass authentication, or access private content. You are responsible for complying with Instagram's Terms of Service, GDPR, and applicable laws. Do not use scraped data for spam, harassment, or any unlawful purpose.

## Responsible Use

This Actor is intended for lawful collection of publicly available information only. Users are responsible for ensuring their use complies with the source website's terms, robots.txt, applicable privacy laws, including India's DPDP Act, and all local regulations.

Do not use this Actor to collect, store, sell, or misuse personal data without a lawful basis. The Actor author is not responsible for misuse by end users.

## License

Apache-2.0. See `LICENSE`.
