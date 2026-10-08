import type { ActivitySummary, InstagramResult, PostRecord, ProfileChanges, ProfileRecord } from './types.js';

const rounded = (value: number): number => Math.round(value * 10_000) / 10_000;
const avg = (values: number[]): number | null => values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
export function summarizeActivity(posts: PostRecord[], followers: number | null, precision: string, now: string): ActivitySummary {
    const known = posts.filter(post => post.likesCount != null && post.commentsCount != null);
    const interactions = known.map(post => post.likesCount! + post.commentsCount!).sort((a, b) => a - b);
    const middle = Math.floor(interactions.length / 2);
    const median = interactions.length ? interactions.length % 2 ? interactions[middle] : (interactions[middle - 1] + interactions[middle]) / 2 : null;
    const dates = posts.map(post => Date.parse(post.postedDate)).filter(date => Number.isFinite(date) && date <= Date.parse(now));
    const latest = dates.length ? Math.max(...dates) : null;
    const spanDays = dates.length >= 2 ? (Math.max(...dates) - Math.min(...dates)) / 86_400_000 : 0;
    return {
        sampledPosts: posts.length, engagementPosts: known.length,
        averageLikes: avg(known.map(post => post.likesCount!)), averageComments: avg(known.map(post => post.commentsCount!)),
        medianInteractions: median,
        engagementRatePercent: followers && precision === 'exact' && interactions.length ? rounded(avg(interactions)! / followers * 100) : null,
        latestPostAt: latest == null ? null : new Date(latest).toISOString(),
        daysSinceLatestPost: latest == null ? null : rounded((Date.parse(now) - latest) / 86_400_000),
        samplePostsPerWeek: spanDays >= 1 ? rounded((dates.length - 1) / spanDays * 7) : null,
        postTypes: { image: posts.filter(post => post.postType === 'image').length, video: posts.filter(post => post.postType === 'video').length,
            reel: posts.filter(post => post.postType === 'reel').length, carousel: posts.filter(post => post.postType === 'carousel').length },
        sampleStatus: posts.length ? 'AVAILABLE' : 'NOT_EXPOSED',
    };
}
export function enrichProfile(result: InstagramResult, includePosts: boolean, limit: number): ProfileRecord {
    const profile = { ...result.profile, qualityFlags: result.profile.qualityFlags.filter(flag => flag !== 'PRIVACY_NOT_CONFIRMED') };
    for (const key of ['followers', 'following', 'postsCount'] as const) {
        if (profile.metricPrecision[key] !== 'exact') profile.qualityFlags.push(`${key.toUpperCase()}_${profile.metricPrecision[key].toUpperCase()}`);
    }
    if (!profile.fieldAvailability.bio) profile.qualityFlags.push('BIO_NOT_EXPOSED');
    if (!profile.fieldAvailability.externalLinks) profile.qualityFlags.push('LINKS_NOT_EXPOSED');
    if (includePosts) {
        profile.recentPosts = result.posts.slice(0, limit);
        profile.activity = summarizeActivity(profile.recentPosts, profile.followers, profile.metricPrecision.followers, profile.scrapedAt);
        if (!profile.recentPosts.length) profile.qualityFlags.push('RECENT_POSTS_NOT_EXPOSED');
    }
    return profile;
}

export type Snapshot = Pick<ProfileRecord, 'username' | 'profileId' | 'followers' | 'following' | 'postsCount' | 'metricPrecision'
    | 'bio' | 'externalLinks' | 'fieldAvailability' | 'scrapedAt'>;
export interface MonitorState { version: 1; profiles: Record<string, Snapshot[]> }
export const MAX_HISTORY_BYTES = 2_000_000;
const historyBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
export function readState(value: unknown): MonitorState {
    if (value == null) return { version: 1, profiles: Object.create(null) };
    const state = value as MonitorState;
    if (typeof value !== 'object' || Array.isArray(value) || state.version !== 1 || !state.profiles || typeof state.profiles !== 'object' || Array.isArray(state.profiles)) throw new Error('Monitor history is invalid; use a new monitorStoreName.');
    if (Object.keys(state.profiles).length > 500 || historyBytes(value) > MAX_HISTORY_BYTES) throw new Error('Monitor history exceeds its safety bound.');
    for (const [key, history] of Object.entries(state.profiles)) {
        if (!/^[a-z0-9._]{1,30}$/.test(key) || !Array.isArray(history) || !history.length || history.length > 10 || history.some(row => !row || typeof row.username !== 'string' || row.username.toLowerCase() !== key
            || typeof row.scrapedAt !== 'string' || !Number.isFinite(Date.parse(row.scrapedAt)) || !row.metricPrecision || !row.fieldAvailability || !Array.isArray(row.externalLinks)
            || row.externalLinks.length > 10 || row.externalLinks.some(link => typeof link !== 'string' || !/^https?:\/\//i.test(link))
            || (row.profileId !== null && (typeof row.profileId !== 'string' || !row.profileId.length))
            || typeof row.bio !== 'string' || typeof row.fieldAvailability.bio !== 'boolean' || typeof row.fieldAvailability.externalLinks !== 'boolean'
            || ['followers', 'following', 'postsCount'].some(field => !['exact', 'rounded', 'unknown'].includes(row.metricPrecision[field as keyof typeof row.metricPrecision]))
            || ['followers', 'following', 'postsCount'].some(field => {
                const n = row[field as keyof Snapshot];
                return n !== null && (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0);
            }))) throw new Error('Monitor history is invalid; use a new monitorStoreName.');
    }
    return { version: 1, profiles: Object.assign(Object.create(null), state.profiles) };
}
export function previousSnapshot(state: MonitorState, username: string, now: string): Snapshot | undefined {
    const previous = Object.hasOwn(state.profiles, username.toLowerCase()) ? state.profiles[username.toLowerCase()].at(-1) : undefined;
    return previous && Date.parse(now) - Date.parse(previous.scrapedAt) <= 30 * 86_400_000 ? previous : undefined;
}
export function compareProfile(current: ProfileRecord, previous: Snapshot | undefined, threshold: number): ProfileChanges {
    const result: ProfileChanges = { status: 'FIRST_SEEN', previousObservedAt: previous?.scrapedAt ?? null, elapsedHours: null,
        followerChange: null, followerChangePercent: null, followerThresholdExceeded: false, followingChange: null, postsCountChange: null,
        bioChanged: null, linksChanged: null, reasons: [] };
    if (!previous) return result;
    const elapsed = Date.parse(current.scrapedAt) - Date.parse(previous.scrapedAt);
    if (elapsed <= 0 || (current.profileId && previous.profileId && current.profileId !== previous.profileId)) {
        return { ...result, status: 'NOT_COMPARABLE', reasons: [elapsed <= 0 ? 'NON_FORWARD_OBSERVATION' : 'PROFILE_ID_CHANGED'] };
    }
    result.elapsedHours = rounded(elapsed / 3_600_000);
    for (const [key, out] of [['followers', 'followerChange'], ['following', 'followingChange'], ['postsCount', 'postsCountChange']] as const) {
        if (current[key] != null && previous[key] != null && current.metricPrecision[key] === 'exact' && previous.metricPrecision[key] === 'exact') {
            result[out] = current[key]! - previous[key]!;
        } else result.reasons.push(`${key.toUpperCase()}_NOT_COMPARABLE`);
    }
    result.followerChangePercent = result.followerChange != null && previous.followers! > 0 ? rounded(result.followerChange / previous.followers! * 100) : null;
    result.followerThresholdExceeded = result.followerChangePercent != null && result.followerChange !== 0 && Math.abs(result.followerChangePercent) >= threshold;
    if (current.fieldAvailability.bio && previous.fieldAvailability.bio) result.bioChanged = current.bio !== previous.bio;
    else result.reasons.push('BIO_NOT_COMPARABLE');
    if (current.fieldAvailability.externalLinks && previous.fieldAvailability.externalLinks) result.linksChanged = JSON.stringify([...current.externalLinks].sort()) !== JSON.stringify([...previous.externalLinks].sort());
    else result.reasons.push('LINKS_NOT_COMPARABLE');
    const changed = [result.followerChange, result.followingChange, result.postsCountChange].some(n => n != null && n !== 0)
        || result.bioChanged === true || result.linksChanged === true;
    result.status = changed ? 'CHANGED' : result.reasons.length ? 'NOT_COMPARABLE' : 'UNCHANGED';
    return result;
}
export function appendSnapshot(state: MonitorState, profile: ProfileRecord): void {
    const { username, profileId, followers, following, postsCount, metricPrecision, bio, externalLinks, fieldAvailability, scrapedAt } = profile;
    const key = username.toLowerCase();
    const snapshot = { username, profileId, followers, following, postsCount, metricPrecision, bio, externalLinks, fieldAvailability, scrapedAt };
    if (historyBytes({ version: 1, profiles: { [key]: [snapshot] } }) > MAX_HISTORY_BYTES) throw new Error('Profile observation exceeds the monitor history size bound.');
    state.profiles[key] = [...(Object.hasOwn(state.profiles, key) ? state.profiles[key] : []).filter(row => row.scrapedAt !== scrapedAt),
        snapshot].slice(-10);
    const entries = Object.entries(state.profiles).filter(([, rows]) => Date.parse(scrapedAt) - Date.parse(rows.at(-1)!.scrapedAt) <= 30 * 86_400_000)
        .sort((a, b) => Date.parse(b[1].at(-1)!.scrapedAt) - Date.parse(a[1].at(-1)!.scrapedAt) || Number(b[0] === key) - Number(a[0] === key)).slice(0, 500);
    state.profiles = Object.assign(Object.create(null), Object.fromEntries(entries));
    // Evict oldest observations first. Never silently truncate the bio or pretend a partial snapshot is comparable.
    let bytes = historyBytes(state);
    while (bytes > MAX_HISTORY_BYTES) {
        const oldest = Object.entries(state.profiles).filter(([name, rows]) => name !== key || rows.length > 1)
            .sort((a, b) => Date.parse(a[1][0].scrapedAt) - Date.parse(b[1][0].scrapedAt))[0];
        if (!oldest) throw new Error('Profile observation exceeds the monitor history size bound.');
        const [name, rows] = oldest;
        if (rows.length > 1) rows.shift();
        else delete state.profiles[name];
        bytes = historyBytes(state);
    }
}
