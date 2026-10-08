import { mergeInstagramResults, parseInstagramHtml, parseInstagramPayload } from './parsers.js';
import { CookieJar } from 'tough-cookie';
import type { InstagramResult } from './types.js';

export interface HttpResponse { statusCode: number; body: string; bodyDiscarded?: boolean; headers: { 'set-cookie'?: string | string[]; location?: string; 'content-type'?: string } }
export interface HttpRequest { url: string; headers: Record<string, string>; proxyUrl?: string; timeoutMs: number; sessionToken?: object }
export type Requester = (request: HttpRequest) => Promise<HttpResponse>;
export type LookupStatus = 'OK' | 'PRIVATE' | 'UNAVAILABLE' | 'BLOCKED' | 'SOURCE_BLOCKED' | 'NO_DATA' | 'PRIVACY_UNKNOWN' | 'TIME_LIMIT' | 'BUDGET_LIMIT' | 'STORAGE_ERROR';
export interface RequestTrace {
    stage: 'profile-page' | 'public-metadata';
    attempt: number;
    statusCode: number | null;
    bodyBytes: number | null;
    bodyDiscarded: boolean;
    contentKind: 'html' | 'json' | 'other' | 'unknown';
    redirect: 'none' | 'login' | 'challenge' | 'instagram' | 'other';
    error: 'TIMEOUT' | 'RESPONSE_TOO_LARGE' | 'NETWORK_ERROR' | null;
}
export interface Lookup { status: LookupStatus; result: InstagramResult | null; requests: number; attempts: number; traces: RequestTrace[] }
export const MAX_PROFILE_REQUESTS = 4;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function redirectKind(location: string | undefined, base: string): RequestTrace['redirect'] {
    if (!location) return 'none';
    try {
        const url = new URL(location, base);
        if (!['www.instagram.com', 'instagram.com'].includes(url.hostname) || url.username || url.password) return 'other';
        if (/^\/accounts\/login(?:\/|$)/.test(url.pathname)) return 'login';
        if (/^\/(?:challenge|checkpoint)(?:\/|$)/.test(url.pathname)) return 'challenge';
        return 'instagram';
    } catch { return 'other'; }
}

function canonicalProfileRedirect(location: string | undefined, base: string, username: string): string | null {
    if (!location) return null;
    try {
        const url = new URL(location, base);
        if (url.protocol !== 'https:' || url.port || url.username || url.password
            || !['www.instagram.com', 'instagram.com'].includes(url.hostname)
            || ![`/${username}`, `/${username}/`].includes(url.pathname.toLowerCase())) return null;
        // Only a language parameter may accompany a same-profile canonical redirect.
        if ([...url.searchParams.keys()].some(key => key !== 'hl') || url.searchParams.getAll('hl').length > 1
            || (url.searchParams.has('hl') && !/^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(url.searchParams.get('hl')!))) return null;
        url.hash = '';
        return url.href;
    } catch { return null; }
}

function rememberCookies(jar: CookieJar, response: HttpResponse, url: string): void {
    const values = response.headers['set-cookie'];
    for (const value of (Array.isArray(values) ? values : values ? [values] : []).slice(0, 30)) {
        if (value.length > 4_096) continue;
        // Scope, expiry, deletion and cookie prefixes are checked by the cookie library.
        try { jar.setCookieSync(value, url, { ignoreError: true }); } catch { /* Ignore malformed optional cookies. */ }
    }
}

function resultStatus(result: InstagramResult | null): LookupStatus {
    if (!result) return 'NO_DATA';
    if (result.profile.isPrivate === true) return 'PRIVATE';
    if (result.profile.isPrivate === null) return 'PRIVACY_UNKNOWN';
    return result.profile.followers != null || result.profile.postsCount != null ? 'OK' : 'NO_DATA';
}
function enough(result: InstagramResult | null, wantsPosts: boolean): boolean {
    const profile = result?.profile;
    return !!profile && profile.isPrivate === false && profile.followers != null && profile.following != null
        && profile.postsCount != null && profile.fieldAvailability.bio && profile.fieldAvailability.externalLinks
        && (!wantsPosts || !!result?.posts.length || profile.postsCount === 0);
}
export async function collectProfile(username: string, request: Requester, newProxy: () => Promise<string | undefined>,
    stopped: () => boolean, wantsPosts = false): Promise<Lookup> {
    let requests = 0;
    let attempts = 0;
    const traces: RequestTrace[] = [];
    let lastStatus: LookupStatus = 'NO_DATA';
    const finish = (status: LookupStatus, result: InstagramResult | null = null): Lookup => ({ status, result, requests, attempts, traces });
    const send = async (options: HttpRequest, stage: RequestTrace['stage']): Promise<HttpResponse> => {
        requests++;
        try {
            const response = await request(options);
            const contentType = response.headers['content-type'] ?? '';
            traces.push({ stage, attempt: attempts, statusCode: response.statusCode, bodyBytes: Buffer.byteLength(response.body, 'utf8'),
                bodyDiscarded: response.bodyDiscarded ?? false,
                contentKind: /json/i.test(contentType) ? 'json' : /html/i.test(contentType) ? 'html' : 'other',
                redirect: redirectKind(response.headers.location, options.url), error: null });
            return response;
        } catch (error) {
            const message = error instanceof Error ? error.message : '';
            traces.push({ stage, attempt: attempts, statusCode: null, bodyBytes: null, bodyDiscarded: false, contentKind: 'unknown', redirect: 'none',
                error: /timeout|timed out/i.test(message) ? 'TIMEOUT' : /safety size/i.test(message) ? 'RESPONSE_TOO_LARGE' : 'NETWORK_ERROR' });
            throw error;
        }
    };
    for (let attempt = 0; attempt < 2 && requests < MAX_PROFILE_REQUESTS; attempt++) {
        if (stopped()) return finish('TIME_LIMIT');
        attempts++;
        const proxyUrl = await newProxy();
        // Reuse generated browser headers as well as the proxy IP/cookies within an attempt.
        const sessionToken = {};
        const jar = new CookieJar(undefined, { prefixSecurity: 'strict' });
        let profileUrl = `https://www.instagram.com/${username}/`;
        let htmlResult: InstagramResult | null = null;
        try {
            let html: HttpResponse;
            const visited = new Set([profileUrl]);
            let redirects = 0;
            while (true) {
                if (stopped()) return finish('TIME_LIMIT');
                const cookies = jar.getCookieStringSync(profileUrl);
                html = await send({ url: profileUrl, proxyUrl, sessionToken, timeoutMs: 20_000,
                    headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9',
                        ...(cookies ? { cookie: cookies } : {}) } }, 'profile-page');
                rememberCookies(jar, html, profileUrl);
                if (!REDIRECT_CODES.has(html.statusCode)) break;
                const kind = redirectKind(html.headers.location, profileUrl);
                if (kind === 'login' || kind === 'challenge') return finish('BLOCKED');
                const next = canonicalProfileRedirect(html.headers.location, profileUrl, username);
                // Never follow another profile, a login/challenge, an external host, or an unbounded loop.
                if (!next || visited.has(next) || redirects >= 1 || requests >= MAX_PROFILE_REQUESTS) return finish('NO_DATA');
                redirects++;
                visited.add(next);
                profileUrl = next;
            }
            if (html.statusCode === 404 || html.statusCode === 410) return finish('UNAVAILABLE');
            // Do not call the optional endpoint on a failed page/session. Respect auth and rate limits.
            if (html.statusCode === 401 || html.statusCode === 429) return finish('BLOCKED');
            if (html.statusCode !== 200) {
                lastStatus = html.statusCode === 403 ? 'BLOCKED' : 'NO_DATA';
                continue;
            }
            htmlResult = parseInstagramHtml(html.body, username);
        } catch { lastStatus = 'NO_DATA'; continue; }
        if (htmlResult?.profile.isPrivate === true) return finish('PRIVATE');
        // Do not spend another proxy request when the page already has complete structured metadata.
        if (enough(htmlResult, wantsPosts)) return finish('OK', htmlResult);
        if (stopped()) return finish('TIME_LIMIT');
        if (requests >= MAX_PROFILE_REQUESTS) return finish(resultStatus(htmlResult), resultStatus(htmlResult) === 'OK' ? htmlResult : null);
        let apiResult: InstagramResult | null = null;
        let terminalBlock = false;
        try {
            const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
            const cookies = jar.getCookieStringSync(apiUrl);
            const csrfToken = cookies.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
            const api = await send({ url: apiUrl,
                proxyUrl, sessionToken, timeoutMs: 12_000, headers: { accept: 'application/json', 'x-ig-app-id': '936619743392459',
                    'x-asbd-id': '198387', referer: profileUrl, origin: 'https://www.instagram.com',
                    ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}), ...(cookies ? { cookie: cookies } : {}) } }, 'public-metadata');
            if (api.statusCode === 200) {
                try { apiResult = parseInstagramPayload(JSON.parse(api.body), username); } catch { /* Keep valid HTML data. */ }
            } else if ([401, 403, 429].includes(api.statusCode)) {
                lastStatus = 'BLOCKED';
                terminalBlock = api.statusCode !== 403;
            } else if (REDIRECT_CODES.has(api.statusCode)
                && ['login', 'challenge'].includes(redirectKind(api.headers.location, apiUrl))) {
                lastStatus = 'BLOCKED'; terminalBlock = true;
            }
        } catch { /* An optional endpoint failure must not discard usable public HTML. */ }
        const merged = mergeInstagramResults(apiResult, htmlResult);
        const status = resultStatus(merged);
        if (status === 'OK') return finish(status, merged);
        if (status === 'PRIVATE') return finish(status);
        if (terminalBlock) return finish('BLOCKED');
        if (merged && lastStatus !== 'BLOCKED') lastStatus = status;
    }
    return finish(lastStatus);
}
