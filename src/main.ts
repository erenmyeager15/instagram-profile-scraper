import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { mergeInstagramResults, parseInstagramHtml, parseInstagramPayload } from './parsers.js';
import type { ActorInput, InstagramResult } from './types.js';

const APP_ID = '936619743392459';
const MAX_PROFILES = 50;

function cookieHeader(setCookie: string | string[] | undefined): string {
    return (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
        .map((value) => value.split(';', 1)[0])
        .filter(Boolean)
        .join('; ');
}

async function fetchProfileApi(
    username: string,
    profileUrl: string,
    proxyUrl: string | undefined,
    cookies: string,
): Promise<InstagramResult | null> {
    const csrfToken = cookies.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
    const response = await gotScraping({
        url: `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        proxyUrl,
        headers: {
            accept: 'application/json',
            'x-ig-app-id': APP_ID,
            'x-asbd-id': '198387',
            ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}),
            ...(cookies ? { cookie: cookies } : {}),
            referer: profileUrl,
            origin: 'https://www.instagram.com',
        },
        timeout: { request: 12_000 },
        retry: { limit: 0 },
        throwHttpErrors: false,
    });
    if (response.statusCode !== 200) return null;
    return parseInstagramPayload(JSON.parse(response.body), username);
}

function normalizeUsername(value: string): string | null {
    const trimmed = value.trim();
    const match = trimmed.match(/instagram\.com\/([^/?#]+)/i);
    const candidate = (match?.[1] ?? trimmed).replace(/^@/, '').toLowerCase();
    return /^[a-z0-9._]{1,30}$/.test(candidate) ? candidate : null;
}

async function storeResult(result: InstagramResult): Promise<void> {
    await Actor.pushData(result.profile, 'profile-scraped');
}

async function fetchProfile(username: string, proxyUrl?: string): Promise<InstagramResult | null> {
    try {
        const profileUrl = `https://www.instagram.com/${username}/`;
        const pageResponse = await gotScraping({
            url: profileUrl,
            proxyUrl,
            headers: {
                accept: 'text/html,application/xhtml+xml',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'no-cache',
            },
            timeout: { request: 20_000 },
            retry: { limit: 0 },
            throwHttpErrors: false,
        });
        if (pageResponse.statusCode !== 200) return null;

        const htmlResult = parseInstagramHtml(pageResponse.body, username);
        const cookies = cookieHeader(pageResponse.headers['set-cookie']);
        const apiResult = await fetchProfileApi(username, profileUrl, proxyUrl, cookies);
        return mergeInstagramResults(apiResult, htmlResult);
    } catch (error) {
        log.debug(`HTTP profile lookup failed for @${username}: ${String(error)}`);
        return null;
    }
}

Actor.main(async () => {
    const input = (await Actor.getInput<ActorInput>()) ?? { usernames: [] };
    const usernames = [...new Set((input.usernames ?? []).map(normalizeUsername).filter((u): u is string => Boolean(u)))];
    if (usernames.length === 0) throw new Error('Provide at least one valid Instagram username or profile URL.');
    if (usernames.length > MAX_PROFILES) throw new Error(`A run can contain at most ${MAX_PROFILES} profiles.`);

    const proxyInput = input.proxyConfiguration;
    const proxyConfiguration = proxyInput?.useApifyProxy
        ? await Actor.createProxyConfiguration(proxyInput.apifyProxyGroups?.length
            ? { groups: proxyInput.apifyProxyGroups }
            : { groups: ['RESIDENTIAL'] })
        : proxyInput?.proxyUrls?.length
            ? await Actor.createProxyConfiguration({ proxyUrls: proxyInput.proxyUrls })
            : undefined;
    let savedProfiles = 0;

    await Actor.setStatusMessage(`Checking ${usernames.length} Instagram profile(s)`);
    for (const username of usernames) {
        let result: InstagramResult | null = null;
        for (let attempt = 1; attempt <= 2 && !result; attempt += 1) {
            const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
            result = await fetchProfile(username, proxyUrl);
            if (!result && attempt === 1) log.info(`Retrying @${username} with a fresh HTTP session.`);
        }
        if (!result) {
            log.warning(`No public profile data returned for @${username}.`);
            continue;
        }
        await storeResult(result);
        savedProfiles += 1;
    }

    if (savedProfiles === 0) {
        throw new Error('No public Instagram profiles could be collected. The targets may be private, unavailable, or temporarily blocked.');
    }
    await Actor.setStatusMessage(`Saved ${savedProfiles}/${usernames.length} profile(s)`);
});
