# Instagram Profile Scraper - Public Profile Analytics

Collect structured metadata and statistics from public Instagram profiles for creator research, brand monitoring, and market analysis.

The Actor uses bounded HTTP sessions with residential proxy rotation and charges only after a profile record is successfully saved.

## What It Extracts

- Username, full name, biography, and profile URL
- Followers, following, and total post count
- Verification and business-account signals
- Business category and public external link
- Profile image URL and privacy status
- Collection timestamp

## Pricing

Each successfully saved public profile costs **$0.002**. Failed, blocked, private, unavailable, and unsaved profiles are not charged.

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

A run accepts up to 50 usernames or profile URLs. Residential proxy rotation is the reliable default because Instagram commonly limits datacenter traffic.

## Sample Output

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
2. A low-cost public HTTP session loads the profile and public metadata endpoint.
3. A failed lookup is retried once with a fresh proxy session.
4. No browser, media download, login, or private endpoint is used.
5. Retries, memory, runtime, and input size are bounded.
6. The run fails clearly when no valid public profile is returned.

## Responsible Use

- Public profiles only; private or login-protected data is not accessed.
- Do not use the Actor for harassment, sensitive-person profiling, deceptive outreach, or attempts to identify private individuals.
- You are responsible for following applicable laws, Instagram's terms, and Apify's platform rules.

## License

Apache-2.0
