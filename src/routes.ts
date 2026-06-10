import type { PlaywrightCrawlingContext } from 'crawlee';
import type { ProfileRecord, PostRecord } from './types.js';
import { Actor } from 'apify';

export interface RouteContext {
    profileDataset: any;
    postDataset: any;
    scrapedPostIds: Set<string>;
    maxPostsPerProfile: number;
    includeReels: boolean;
    includeCarousels: boolean;
}

export function cleanInstagramUrl(input: string): string {
    let cleaned = input.trim();
    cleaned = cleaned.replace(/^https?:\/\/(www\.)?instagram\.com\//, '');
    cleaned = cleaned.replace(/\/$/, '');
    cleaned = cleaned.replace(/^@/, '');
    return cleaned;
}

export async function handleProfilePage(
    context: PlaywrightCrawlingContext,
    routeContext: RouteContext,
): Promise<void> {
    const { request, page, log } = context;
    const { profileDataset, scrapedPostIds, maxPostsPerProfile, includeReels, includeCarousels, postDataset } = routeContext;

    const delay = 2000 + Math.random() * 4000;
    await page.waitForTimeout(delay);

    const url = request.url;
    const username = extractUsername(url);
    if (!username) {
        log.warning(`Could not extract username from URL: ${url}`);
        return;
    }

    log.info(`Scraping profile: @${username}`);

    const profile = await extractProfileData(page, username);

    if (profile.isPrivate) {
        log.warning(`Profile @${username} is private. Skipping.`);
        await profileDataset.pushData(profile);
        return;
    }

    await profileDataset.pushData(profile);
    await Actor.charge({ eventName: 'profile-scraped' });

    log.info(`Profile scraped: @${profile.username} (${profile.followers} followers)`);

    if (maxPostsPerProfile > 0) {
        await scrapeAndExtractPosts(
            page,
            profile.username,
            maxPostsPerProfile,
            includeReels,
            includeCarousels,
            postDataset,
            scrapedPostIds,
            log,
        );
    }
}

async function extractProfileData(page: any, username: string): Promise<ProfileRecord> {
    const profile: ProfileRecord = {
        username,
        fullName: '',
        bio: '',
        followers: 0,
        following: 0,
        postsCount: 0,
        profileImageUrl: '',
        isVerified: false,
        isBusinessAccount: false,
        businessCategory: '',
        externalLink: '',
        profileUrl: `https://www.instagram.com/${username}/`,
        isPrivate: false,
        scrapedAt: new Date().toISOString(),
    };

    try {
        const privateIndicator = await page.locator('header').locator('text=This account is private').count();
        if (privateIndicator > 0) {
            profile.isPrivate = true;
            return profile;
        }

        const fullNameEl = await page.locator('header section span').first();
        profile.fullName = (await fullNameEl.textContent()) || '';

        const bioSpans = await page.locator('header section div > div > span').allTextContents();
        if (bioSpans.length > 0) {
            profile.bio = bioSpans[bioSpans.length - 1] || '';
        }

        const statsItems = await page.locator('header section ul li').allTextContents();
        for (const stat of statsItems) {
            const lower = stat.toLowerCase();
            if (lower.includes('post')) {
                profile.postsCount = parseCount(stat);
            } else if (lower.includes('follower')) {
                profile.followers = parseCount(stat);
            } else if (lower.includes('following')) {
                profile.following = parseCount(stat);
            }
        }

        const imgSrc = await page.locator('header img').first().getAttribute('src');
        profile.profileImageUrl = imgSrc || '';

        const verifiedBadge = await page.locator('header svg[aria-label="Verified"]').count();
        profile.isVerified = verifiedBadge > 0;

        const categoryEl = await page.locator('header section div > div > span').first();
        const categoryText = (await categoryEl.textContent()) || '';
        if (categoryText && !categoryText.includes(profile.fullName) && categoryText !== profile.username) {
            profile.businessCategory = categoryText;
            profile.isBusinessAccount = true;
        }

        const linkEl = await page.locator('header section a[href*="l.instagram.com"]').first();
        if (await linkEl.count() > 0) {
            profile.externalLink = (await linkEl.getAttribute('href')) || '';
        }
    } catch {
        // Return profile with defaults on error
    }

    return profile;
}

async function scrapeAndExtractPosts(
    page: any,
    username: string,
    maxPosts: number,
    includeReels: boolean,
    includeCarousels: boolean,
    postDataset: any,
    scrapedPostIds: Set<string>,
    log: any,
): Promise<void> {
    log.info(`Scrolling to load posts for @${username}...`);

    let previousCount = 0;
    let noNewContentCount = 0;

    for (let i = 0; i < 50; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await page.waitForTimeout(1500 + Math.random() * 2000);

        const currentCount = await page.locator('article a[href*="/p/"], article a[href*="/reel/"]').count();

        if (currentCount === previousCount) {
            noNewContentCount++;
            if (noNewContentCount >= 3) break;
        } else {
            noNewContentCount = 0;
        }
        previousCount = currentCount;

        if (currentCount >= maxPosts) break;
    }

    const hrefs: string[] = await page
        .locator('article a[href*="/p/"], article a[href*="/reel/"]')
        .evaluateAll((els: Element[]) =>
            els
                .map((e: Element) => (e as HTMLAnchorElement).getAttribute('href'))
                .filter((h: string | null): h is string => Boolean(h)),
        );
    const uniqueHrefs = [...new Set(hrefs)].slice(0, maxPosts);

    log.info(`Found ${uniqueHrefs.length} posts for @${username}`);

    for (const href of uniqueHrefs) {
        try {
            const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;

            const postIdMatch = href.match(/\/(?:p|reel)\/([^/]+)/);
            if (!postIdMatch) continue;
            const postId = postIdMatch[1];

            if (scrapedPostIds.has(postId)) {
                continue;
            }

            // Navigate directly to the post page instead of clicking the modal,
            // which is far more reliable than depending on Instagram's grid click handler.
            await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            await page.waitForTimeout(2000 + Math.random() * 2000);

            const post = await extractSinglePost(page, fullUrl, postId, username);

            if (!includeReels && post.postType === 'reel') continue;
            if (!includeCarousels && post.postType === 'carousel') continue;

            scrapedPostIds.add(postId);
            await postDataset.pushData(post);
        } catch (err) {
            log.warning(`Error extracting post: ${err}`);
        }
    }
}

async function extractSinglePost(
    page: any,
    postUrl: string,
    postId: string,
    username: string,
): Promise<PostRecord> {
    const post: PostRecord = {
        postId,
        postUrl,
        postType: 'image',
        caption: '',
        hashtags: [],
        mentions: [],
        likesCount: 0,
        commentsCount: 0,
        viewsCount: null,
        postedDate: '',
        thumbnailUrl: '',
        locationTag: '',
        isSponsored: false,
        productTagsFlag: false,
        username,
        scrapedAt: new Date().toISOString(),
    };

    try {
        if (postUrl.includes('/reel/')) {
            post.postType = 'reel';
        } else {
            const slideCount = await page.locator('[aria-label="Go to item"]').count();
            const hasVideo = await page.locator('video').count();

            if (slideCount > 1) {
                post.postType = 'carousel';
            } else if (hasVideo > 0) {
                post.postType = 'video';
            }
        }

        const captionEl = await page.locator('div[role="button"] span, h1').first();
        if (await captionEl.count() > 0) {
            const fullCaption = await captionEl.textContent();
            post.caption = fullCaption ? fullCaption.substring(0, 500) : '';
        }

        const hashtagMatches = post.caption.match(/#[\w\u00C0-\u024F]+/g);
        post.hashtags = hashtagMatches || [];

        const mentionMatches = post.caption.match(/@[\w.]+/g);
        post.mentions = mentionMatches || [];

        const likeSelectors = [
            'a[href*="liked_by"] span',
            'section span a[href*="liked_by"]',
        ];

        for (const selector of likeSelectors) {
            const likeText = await page.locator(selector).first().textContent();
            if (likeText && /\d/.test(likeText)) {
                post.likesCount = parseCount(likeText);
                break;
            }
        }

        const commentText = await page.locator('ul ul li span').first().textContent();
        if (commentText && /\d/.test(commentText)) {
            post.commentsCount = parseCount(commentText);
        }

        const timeEl = await page.locator('time').first();
        if (await timeEl.count() > 0) {
            post.postedDate = (await timeEl.getAttribute('datetime')) || '';
        }

        const locationEl = await page.locator('a[href*="/explore/locations/"]').first();
        if (await locationEl.count() > 0) {
            post.locationTag = (await locationEl.textContent()) || '';
        }

        const sponsoredCount = await page.locator('span:has-text("Paid partnership")').count();
        post.isSponsored = sponsoredCount > 0;

        const productTagCount = await page.locator('div[role="button"]:has-text("View products")').count();
        post.productTagsFlag = productTagCount > 0;

        const thumbEl = await page.locator('article img').first();
        if (await thumbEl.count() > 0) {
            post.thumbnailUrl = (await thumbEl.getAttribute('src')) || '';
        }
    } catch {
        // Return post with defaults
    }

    return post;
}

function extractUsername(url: string): string | null {
    const match = url.match(/instagram\.com\/([^/?]+)/);
    return match ? match[1] : null;
}

function parseCount(text: string): number {
    const cleaned = text.replace(/,/g, '').trim();
    const billionMatch = cleaned.match(/([\d.]+)\s*b/i);
    if (billionMatch) return Math.round(parseFloat(billionMatch[1]) * 1_000_000_000);

    const millionMatch = cleaned.match(/([\d.]+)\s*m/i);
    if (millionMatch) return Math.round(parseFloat(millionMatch[1]) * 1_000_000);

    const thousandMatch = cleaned.match(/([\d.]+)\s*k/i);
    if (thousandMatch) return Math.round(parseFloat(thousandMatch[1]) * 1_000);

    const numMatch = cleaned.match(/(\d+)/);
    return numMatch ? parseInt(numMatch[1], 10) : 0;
}
