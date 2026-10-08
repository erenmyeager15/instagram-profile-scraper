import type { ActorInput } from './types.js';

const RESERVED = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'about', 'developer', 'legal', 'challenge']);
export function normalizeUsername(value: string): string | null {
    let candidate = value.trim();
    if (/^(?:https?:\/\/|(?:www\.)?instagram\.com\/)/i.test(candidate)) {
        try {
            const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
            if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
            const path = url.pathname.split('/').filter(Boolean);
            if (path.length !== 1) return null;
            candidate = path[0];
        } catch { return null; }
    }
    candidate = candidate.replace(/^@/, '').toLowerCase();
    return /^[a-z0-9._]{1,30}$/.test(candidate) && !RESERVED.has(candidate) ? candidate : null;
}

export interface ValidatedInput {
    usernames: string[];
    invalidInputs: number;
    duplicatesRemoved: number;
    proxy: { useApifyProxy: boolean; groups?: string[]; proxyUrls?: string[]; countryCode?: string };
    includeRecentPosts: boolean;
    maxRecentPosts: number;
    monitorStoreName: string;
    followerChangeThresholdPercent: number;
    maxRunSeconds: number;
}
function bounded(value: unknown, fallback: number, min: number, max: number, field: string): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
        || (field !== 'followerChangeThresholdPercent' && !Number.isInteger(value))) throw new Error(`${field} must be between ${min} and ${max}.`);
    return value;
}
export function validateInput(raw: ActorInput): ValidatedInput {
    if (!Array.isArray(raw.usernames) || !raw.usernames.every(value => typeof value === 'string') || raw.usernames.length > 500) {
        throw new Error('Provide an array of usernames or profile URLs (at most 50 unique profiles).');
    }
    const normalized = raw.usernames.map(normalizeUsername);
    const valid = normalized.filter((value): value is string => !!value);
    const usernames = [...new Set(valid)];
    if (!usernames.length || usernames.length > 50) throw new Error('Provide between 1 and 50 valid unique Instagram usernames or profile URLs.');
    if (raw.includeRecentPosts !== undefined && typeof raw.includeRecentPosts !== 'boolean') throw new Error('includeRecentPosts must be boolean.');
    if (raw.monitorStoreName !== undefined && raw.monitorStoreName !== '' && (typeof raw.monitorStoreName !== 'string' || !/^[\w-]{1,64}$/.test(raw.monitorStoreName))) {
        throw new Error('monitorStoreName must contain 1-64 letters, numbers, underscores or hyphens.');
    }
    const proxy = raw.proxyConfiguration;
    if (proxy != null && (typeof proxy !== 'object' || Array.isArray(proxy))) throw new Error('Invalid proxyConfiguration.');
    for (const key of ['apifyProxyGroups', 'proxyUrls'] as const) {
        if (proxy?.[key] !== undefined && (!Array.isArray(proxy[key]) || !proxy[key]!.every(item => typeof item === 'string'))) throw new Error(`Invalid ${key}.`);
    }
    if (proxy?.useApifyProxy !== undefined && typeof proxy.useApifyProxy !== 'boolean') throw new Error('useApifyProxy must be boolean.');
    if (proxy?.apifyProxyCountry && !/^[A-Z]{2}$/.test(proxy.apifyProxyCountry)) throw new Error('Use a two-letter uppercase proxy country.');
    return {
        usernames, invalidInputs: normalized.length - valid.length, duplicatesRemoved: valid.length - usernames.length,
        proxy: proxy?.proxyUrls?.length && !proxy.useApifyProxy ? { useApifyProxy: false, proxyUrls: proxy.proxyUrls }
            : proxy?.useApifyProxy === false ? { useApifyProxy: false }
                : { useApifyProxy: true, groups: proxy?.apifyProxyGroups?.length ? proxy.apifyProxyGroups : ['RESIDENTIAL'],
                    ...(proxy?.apifyProxyCountry ? { countryCode: proxy.apifyProxyCountry } : {}) },
        includeRecentPosts: raw.includeRecentPosts ?? false,
        maxRecentPosts: bounded(raw.maxRecentPosts, 6, 1, 12, 'maxRecentPosts'),
        monitorStoreName: raw.monitorStoreName ?? '',
        followerChangeThresholdPercent: bounded(raw.followerChangeThresholdPercent, 5, 0, 100, 'followerChangeThresholdPercent'),
        maxRunSeconds: bounded(raw.maxRunSeconds, 240, 30, 840, 'maxRunSeconds'),
    };
}
