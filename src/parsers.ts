import type { InstagramResult, PostRecord, ProfileRecord } from './types.js';

type JsonRecord = Record<string, any>;

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const number = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
const postCount = (value: unknown, followers: number): number | null => {
    if (value == null || value === '') return null;
    const parsed = number(value);
    return parsed === 0 && followers > 0 ? null : parsed;
};

export function parseCount(value: string): number {
    const cleaned = value.replace(/,/g, '').trim();
    const match = cleaned.match(/([\d.]+)\s*([bmk])?/i);
    if (!match) return 0;
    const multiplier = match[2]?.toLowerCase() === 'b' ? 1_000_000_000
        : match[2]?.toLowerCase() === 'm' ? 1_000_000
            : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
    return Math.round(Number(match[1]) * multiplier);
}

function findUser(value: unknown, requestedUsername: string, depth = 0): JsonRecord | null {
    if (!value || typeof value !== 'object' || depth > 10) return null;
    const record = value as JsonRecord;
    if (text(record.username).toLowerCase() === requestedUsername.toLowerCase()
        && ('edge_followed_by' in record || 'full_name' in record || 'is_private' in record)) return record;
    for (const child of Object.values(record)) {
        if (Array.isArray(child)) {
            for (const item of child) {
                const found = findUser(item, requestedUsername, depth + 1);
                if (found) return found;
            }
        } else {
            const found = findUser(child, requestedUsername, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

function edgeText(node: JsonRecord): string {
    return text(node?.edge_media_to_caption?.edges?.[0]?.node?.text);
}

function mapPosts(user: JsonRecord, username: string): PostRecord[] {
    const edges = user?.edge_owner_to_timeline_media?.edges ?? [];
    return edges.map((edge: JsonRecord): PostRecord | null => {
        const node = edge?.node ?? edge;
        const shortcode = text(node.shortcode);
        const id = text(node.id) || shortcode;
        if (!id || !shortcode) return null;
        const caption = edgeText(node);
        const typename = text(node.__typename);
        const postType: PostRecord['postType'] = text(node.product_type).toLowerCase() === 'clips' ? 'reel'
            : typename === 'GraphSidecar' ? 'carousel'
                : typename === 'GraphVideo' && Boolean(node.is_video) ? 'video' : 'image';
        return {
            postId: id,
            postUrl: `https://www.instagram.com/p/${shortcode}/`,
            postType,
            caption,
            hashtags: caption.match(/#[\p{L}\p{N}_]+/gu) ?? [],
            mentions: caption.match(/@[a-z0-9._]+/gi) ?? [],
            likesCount: number(node?.edge_liked_by?.count ?? node?.edge_media_preview_like?.count),
            commentsCount: number(node?.edge_media_to_comment?.count ?? node?.edge_media_to_parent_comment?.count),
            viewsCount: node.video_view_count == null ? null : number(node.video_view_count),
            postedDate: node.taken_at_timestamp ? new Date(number(node.taken_at_timestamp) * 1000).toISOString() : '',
            thumbnailUrl: text(node.display_url ?? node.thumbnail_src),
            locationTag: text(node?.location?.name),
            isSponsored: Boolean(node.is_paid_partnership),
            productTagsFlag: Boolean(node.product_type),
            username,
            scrapedAt: new Date().toISOString(),
        };
    }).filter((post: PostRecord | null): post is PostRecord => Boolean(post));
}

export function parseInstagramPayload(payload: unknown, requestedUsername: string): InstagramResult | null {
    const direct = (payload as JsonRecord)?.data?.user ?? (payload as JsonRecord)?.user;
    const user = direct && typeof direct === 'object' ? direct : findUser(payload, requestedUsername);
    if (!user || !text(user.username)) return null;
    const username = text(user.username);
    const followers = number(user?.edge_followed_by?.count ?? user.follower_count);
    const profile: ProfileRecord = {
        username,
        fullName: text(user.full_name),
        bio: text(user.biography),
        followers,
        following: number(user?.edge_follow?.count ?? user.following_count),
        postsCount: postCount(user?.edge_owner_to_timeline_media?.count ?? user.media_count, followers),
        profileImageUrl: text(user.profile_pic_url_hd ?? user.profile_pic_url),
        isVerified: Boolean(user.is_verified),
        isBusinessAccount: Boolean(user.is_business_account ?? user.is_professional_account),
        businessCategory: text(user.business_category_name ?? user.category_name),
        externalLink: text(user.external_url),
        profileUrl: `https://www.instagram.com/${username}/`,
        isPrivate: Boolean(user.is_private),
        scrapedAt: new Date().toISOString(),
    };
    return { profile, posts: mapPosts(user, username) };
}

export function mergeInstagramResults(
    primary: InstagramResult | null,
    fallback: InstagramResult | null,
): InstagramResult | null {
    if (!primary) return fallback;
    if (!fallback) return primary;

    return {
        profile: {
            ...primary.profile,
            fullName: primary.profile.fullName || fallback.profile.fullName,
            bio: primary.profile.bio || fallback.profile.bio,
            followers: primary.profile.followers || fallback.profile.followers,
            following: primary.profile.following || fallback.profile.following,
            postsCount: primary.profile.postsCount ?? fallback.profile.postsCount,
            profileImageUrl: primary.profile.profileImageUrl || fallback.profile.profileImageUrl,
            businessCategory: primary.profile.businessCategory || fallback.profile.businessCategory,
            externalLink: primary.profile.externalLink || fallback.profile.externalLink,
        },
        posts: primary.posts.length > 0 ? primary.posts : fallback.posts,
    };
}

export function parseInstagramHtml(html: string, requestedUsername: string): InstagramResult | null {
    const scripts = html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const script of scripts) {
        try {
            const result = parseInstagramPayload(JSON.parse(script[1]), requestedUsername);
            if (result) return result;
        } catch { /* Try the next JSON block. */ }
    }

    const description = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i)?.[1] ?? '';
    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i)?.[1] ?? '';
    if (!description || !title.toLowerCase().includes(`@${requestedUsername.toLowerCase()}`)) return null;
    const counts = description.match(/([\d.,KMB]+)\s+Followers,\s+([\d.,KMB]+)\s+Following,\s+([\d.,KMB]+)\s+Posts/i);
    return {
        profile: {
            username: requestedUsername,
            fullName: title.split('(@')[0].trim(),
            bio: '',
            followers: counts ? parseCount(counts[1]) : 0,
            following: counts ? parseCount(counts[2]) : 0,
            postsCount: counts ? parseCount(counts[3]) : null,
            profileImageUrl: '',
            isVerified: false,
            isBusinessAccount: false,
            businessCategory: '',
            externalLink: '',
            profileUrl: `https://www.instagram.com/${requestedUsername}/`,
            isPrivate: false,
            scrapedAt: new Date().toISOString(),
        },
        posts: [],
    };
}
