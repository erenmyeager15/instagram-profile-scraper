import type { InstagramResult, PostRecord, ProfileRecord } from './types.js';

type JsonRecord = Record<string, any>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
export const count = (value: unknown): number | null => {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export function parseCount(value: string): number | null {
    const match = value.replace(/,/g, '').trim().match(/^(\d+(?:\.\d+)?)\s*([bmk])?$/i);
    if (!match) return null;
    const multiplier = match[2]?.toLowerCase() === 'b' ? 1e9 : match[2]?.toLowerCase() === 'm' ? 1e6
        : match[2]?.toLowerCase() === 'k' ? 1e3 : 1;
    return count(Math.round(Number(match[1]) * multiplier));
}

function findUser(value: unknown, requested: string, depth = 0, budget = { remaining: 10_000 }): JsonRecord | null {
    if (!value || typeof value !== 'object' || depth > 12 || --budget.remaining < 0) return null;
    const record = value as JsonRecord;
    if (text(record.username).toLowerCase() === requested.toLowerCase()
        && ('edge_followed_by' in record || 'follower_count' in record || 'is_private' in record)) return record;
    for (const child of Object.values(record)) {
        const found = findUser(child, requested, depth + 1, budget);
        if (found) return found;
    }
    return null;
}

export function publicLink(value: unknown): string | null {
    try {
        let url = new URL(text(value));
        if (url.hostname === 'l.instagram.com' && url.searchParams.has('u')) url = new URL(url.searchParams.get('u')!);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        url.hash = '';
        return url.href;
    } catch { return null; }
}

function mapPosts(user: JsonRecord, username: string, observedAt: string): PostRecord[] {
    const rawEdges = user?.edge_owner_to_timeline_media?.edges;
    const edges = Array.isArray(rawEdges) ? rawEdges : Array.isArray(user.items) ? user.items : [];
    const posts: PostRecord[] = [];
    const seen = new Set<string>();
    for (const edge of edges.slice(0, 24)) {
        const node = edge?.node ?? edge;
        if (!node || typeof node !== 'object') continue;
        const shortcode = text(node.shortcode ?? node.code);
        if (!/^[\w-]+$/.test(shortcode) || seen.has(shortcode)) continue;
        seen.add(shortcode);
        const caption = text(node?.edge_media_to_caption?.edges?.[0]?.node?.text ?? node?.caption?.text);
        const typename = text(node.__typename);
        const postType: PostRecord['postType'] = text(node.product_type).toLowerCase() === 'clips' ? 'reel'
            : typename === 'GraphSidecar' || node.media_type === 8 ? 'carousel'
                : typename === 'GraphVideo' || node.is_video === true || node.media_type === 2 ? 'video' : 'image';
        const timestamp = count(node.taken_at_timestamp ?? node.taken_at);
        const date = timestamp == null ? NaN : timestamp * 1000;
        posts.push({
            postId: text(node.id) || (typeof node.pk === 'number' ? String(node.pk) : text(node.pk)) || shortcode,
            postUrl: `https://www.instagram.com/${postType === 'reel' ? 'reel' : 'p'}/${shortcode}/`,
            postType, caption, hashtags: [...new Set(caption.match(/#[\p{L}\p{N}_]+/gu) ?? [])],
            mentions: [...new Set(caption.match(/@[a-z0-9._]+/gi) ?? [])],
            likesCount: count(node?.edge_liked_by?.count ?? node?.edge_media_preview_like?.count ?? node.like_count),
            commentsCount: count(node?.edge_media_to_comment?.count ?? node?.edge_media_to_parent_comment?.count ?? node.comment_count),
            viewsCount: count(node.video_view_count ?? node.play_count),
            // Optional bad dates must not discard a valid profile.
            postedDate: Number.isFinite(date) && date > 0 && date <= Date.parse(observedAt) ? new Date(date).toISOString() : '',
            thumbnailUrl: text(node.display_url ?? node.thumbnail_src ?? node.image_versions2?.candidates?.[0]?.url),
            locationTag: text(node?.location?.name), isSponsored: boolean(node.is_paid_partnership),
            productTagsFlag: node.product_tags?.length > 0 ? true : Array.isArray(node.product_tags) ? false : null,
            username, scrapedAt: observedAt,
        });
        if (posts.length >= 12) break;
    }
    return posts;
}

export function parseInstagramPayload(payload: unknown, requestedUsername: string): InstagramResult | null {
    const user = findUser(payload, requestedUsername);
    if (!user) return null;
    const username = text(user.username);
    const followers = count(user?.edge_followed_by?.count ?? user.follower_count);
    const following = count(user?.edge_follow?.count ?? user.following_count);
    const rawPosts = user?.edge_owner_to_timeline_media?.count ?? user.media_count;
    // Instagram sometimes emits a zero placeholder for large profiles. Do not call it exact.
    const postsCount = count(user.all_media_count) ?? (count(rawPosts) === 0 && (followers ?? 0) > 0 ? null : count(rawPosts));
    const rawLinks = Array.isArray(user.bio_links) ? user.bio_links.slice(0, 20).map((link: JsonRecord) => link?.url ?? link?.lynx_url) : [];
    const externalLinks = [...new Set([user.external_url, ...rawLinks].map(publicLink).filter((link): link is string => !!link))].slice(0, 10);
    const scrapedAt = new Date().toISOString();
    const profile: ProfileRecord = {
        username, profileId: text(user.id ?? user.pk) || (typeof (user.id ?? user.pk) === 'number' && Number.isSafeInteger(user.id ?? user.pk) ? String(user.id ?? user.pk) : null), fullName: text(user.full_name), bio: text(user.biography),
        followers, following, postsCount, profileImageUrl: text(user.profile_pic_url_hd ?? user.profile_pic_url),
        isVerified: boolean(user.is_verified), isBusinessAccount: boolean(user.is_business_account ?? user.is_professional_account),
        businessCategory: text(user.business_category_name ?? user.category_name),
        externalLink: externalLinks[0] ?? '', externalLinks,
        externalDomains: [...new Set(externalLinks.map(link => new URL(link).hostname))],
        profileUrl: `https://www.instagram.com/${username}/`, isPrivate: boolean(user.is_private), scrapedAt,
        fieldAvailability: { bio: typeof user.biography === 'string',
            externalLinks: typeof user.external_url === 'string' || Array.isArray(user.bio_links) },
        metricPrecision: { followers: followers == null ? 'unknown' : 'exact', following: following == null ? 'unknown' : 'exact',
            postsCount: postsCount == null ? 'unknown' : 'exact' }, dataSource: 'public-json', qualityFlags: [],
    };
    return { profile, posts: profile.isPrivate === false ? mapPosts(user, username, scrapedAt) : [] };
}

export function mergeInstagramResults(primary: InstagramResult | null, fallback: InstagramResult | null): InstagramResult | null {
    if (!primary) return fallback;
    if (!fallback || primary.profile.username.toLowerCase() !== fallback.profile.username.toLowerCase()) return primary;
    if (primary.profile.profileId && fallback.profile.profileId && primary.profile.profileId !== fallback.profile.profileId) {
        // A conflicting identity must not override a private signal with public data.
        const isPrivate = primary.profile.isPrivate === true || fallback.profile.isPrivate === true ? true : null;
        return { profile: { ...primary.profile, isPrivate, qualityFlags: [...primary.profile.qualityFlags, 'SOURCE_ID_CONFLICT'] }, posts: [] };
    }
    const profile = { ...primary.profile, metricPrecision: { ...primary.profile.metricPrecision }, dataSource: 'merged' as const };
    for (const key of ['followers', 'following', 'postsCount'] as const) {
        if (profile[key] == null || (profile.metricPrecision[key] !== 'exact' && fallback.profile.metricPrecision[key] === 'exact')) {
            profile[key] = fallback.profile[key];
            profile.metricPrecision[key] = fallback.profile.metricPrecision[key];
        }
    }
    for (const key of ['fullName', 'profileImageUrl', 'businessCategory'] as const) profile[key] ||= fallback.profile[key];
    if (!profile.fieldAvailability.bio && fallback.profile.fieldAvailability.bio) profile.bio = fallback.profile.bio;
    if (!profile.fieldAvailability.externalLinks && fallback.profile.fieldAvailability.externalLinks) profile.externalLinks = fallback.profile.externalLinks;
    profile.fieldAvailability = { bio: profile.fieldAvailability.bio || fallback.profile.fieldAvailability.bio,
        externalLinks: profile.fieldAvailability.externalLinks || fallback.profile.fieldAvailability.externalLinks };
    for (const key of ['isVerified', 'isBusinessAccount', 'isPrivate'] as const) profile[key] ??= fallback.profile[key];
    if (fallback.profile.isPrivate === true) profile.isPrivate = true;
    profile.profileId ??= fallback.profile.profileId;
    // An explicitly empty primary link list means removed links, not missing data.
    profile.externalLinks = [...new Set(profile.externalLinks)].slice(0, 10);
    profile.externalLink = profile.externalLinks[0] ?? '';
    profile.externalDomains = [...new Set(profile.externalLinks.map(link => new URL(link).hostname))];
    return { profile, posts: profile.isPrivate === false ? (primary.posts.length ? primary.posts : fallback.posts) : [] };
}

function decodeHtml(value: string): string {
    return value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|quot|apos|lt|gt);/gi, (whole, numeric: string, named: string) => {
        if (numeric) {
            const code = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[named.toLowerCase()] ?? whole;
    });
}

export function parseInstagramHtml(html: string, requestedUsername: string): InstagramResult | null {
    let structured: InstagramResult | null = null;
    let blocks = 0;
    for (const script of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        if (++blocks > 100) break;
        try {
            const result = parseInstagramPayload(JSON.parse(script[1]), requestedUsername);
            if (result) structured = mergeInstagramResults(result, structured);
        } catch { /* Try the next public JSON block. */ }
    }
    const meta: Record<string, string> = {};
    for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
        const attrs: Record<string, string> = {};
        for (const attr of tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attrs[attr[1].toLowerCase()] = decodeHtml(attr[3]);
        if (attrs.property) meta[attrs.property.toLowerCase()] = attrs.content ?? '';
    }
    const title = meta['og:title'] ?? '';
    if (title.match(/\(@([a-z0-9._]+)\)/i)?.[1]?.toLowerCase() !== requestedUsername.toLowerCase()) return structured;
    const counts = (meta['og:description'] ?? '').match(/([\d.,]+\s*[KMB]?)\s+Followers,\s+([\d.,]+\s*[KMB]?)\s+Following,\s+([\d.,]+\s*[KMB]?)\s+Posts/i);
    if (!counts) return structured;
    const values = counts.slice(1).map(parseCount);
    const precision = (index: number): 'exact' | 'rounded' | 'unknown' => values[index] == null ? 'unknown'
        : /[kmb]/i.test(counts[index + 1]) ? 'rounded' : 'exact';
    return mergeInstagramResults(structured, { profile: {
        username: requestedUsername, profileId: null, fullName: title.split('(@')[0].trim(), bio: '',
        followers: values[0], following: values[1], postsCount: values[2],
        profileImageUrl: meta['og:image'] ?? '', isVerified: null, isBusinessAccount: null,
        businessCategory: '', externalLink: '', externalLinks: [], externalDomains: [],
        profileUrl: `https://www.instagram.com/${requestedUsername}/`, isPrivate: null,
        scrapedAt: new Date().toISOString(), metricPrecision: { followers: precision(0), following: precision(1), postsCount: precision(2) },
        dataSource: 'page-metadata', qualityFlags: ['PRIVACY_NOT_CONFIRMED'], fieldAvailability: { bio: false, externalLinks: false },
    }, posts: [] });
}
