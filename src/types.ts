export interface ActorInput {
    usernames: string[];
    proxyConfiguration?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        proxyUrls?: string[];
        apifyProxyCountry?: string;
    };
    includeRecentPosts?: boolean;
    maxRecentPosts?: number;
    monitorStoreName?: string;
    followerChangeThresholdPercent?: number;
    maxRunSeconds?: number;
}

export interface InstagramResult {
    profile: ProfileRecord;
    posts: PostRecord[];
}

export interface ProfileRecord {
    username: string;
    fullName: string;
    bio: string;
    followers: number | null;
    following: number | null;
    postsCount: number | null;
    profileImageUrl: string;
    isVerified: boolean | null;
    isBusinessAccount: boolean | null;
    businessCategory: string;
    externalLink: string;
    profileUrl: string;
    isPrivate: boolean | null;
    scrapedAt: string;
    profileId: string | null;
    externalLinks: string[];
    externalDomains: string[];
    metricPrecision: Record<'followers' | 'following' | 'postsCount', 'exact' | 'rounded' | 'unknown'>;
    dataSource: 'public-json' | 'page-metadata' | 'merged';
    qualityFlags: string[];
    fieldAvailability: { bio: boolean; externalLinks: boolean };
    recentPosts?: PostRecord[];
    activity?: ActivitySummary;
    changes?: ProfileChanges;
}

export interface ActivitySummary {
    sampledPosts: number;
    engagementPosts: number;
    averageLikes: number | null;
    averageComments: number | null;
    medianInteractions: number | null;
    engagementRatePercent: number | null;
    latestPostAt: string | null;
    daysSinceLatestPost: number | null;
    samplePostsPerWeek: number | null;
    postTypes: Record<PostRecord['postType'], number>;
    sampleStatus: 'AVAILABLE' | 'NOT_EXPOSED';
}

export interface ProfileChanges {
    status: 'FIRST_SEEN' | 'CHANGED' | 'UNCHANGED' | 'NOT_COMPARABLE';
    previousObservedAt: string | null;
    elapsedHours: number | null;
    followerChange: number | null;
    followerChangePercent: number | null;
    followerThresholdExceeded: boolean;
    followingChange: number | null;
    postsCountChange: number | null;
    bioChanged: boolean | null;
    linksChanged: boolean | null;
    reasons: string[];
}

export interface PostRecord {
    postId: string;
    postUrl: string;
    postType: 'image' | 'video' | 'carousel' | 'reel';
    caption: string;
    hashtags: string[];
    mentions: string[];
    likesCount: number | null;
    commentsCount: number | null;
    viewsCount: number | null;
    postedDate: string;
    thumbnailUrl: string;
    locationTag: string;
    isSponsored: boolean | null;
    productTagsFlag: boolean | null;
    username: string;
    scrapedAt: string;
}
