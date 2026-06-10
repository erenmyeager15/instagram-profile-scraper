export interface ActorInput {
    usernames: string[];
    maxPostsPerProfile: number;
    includeReels: boolean;
    includeCarousels: boolean;
    proxyConfiguration: {
        useApifyProxy: boolean;
        apifyProxyGroups: string[];
        proxyUrls: string[];
    };
}

export interface ProfileRecord {
    username: string;
    fullName: string;
    bio: string;
    followers: number;
    following: number;
    postsCount: number;
    profileImageUrl: string;
    isVerified: boolean;
    isBusinessAccount: boolean;
    businessCategory: string;
    externalLink: string;
    profileUrl: string;
    isPrivate: boolean;
    scrapedAt: string;
}

export interface PostRecord {
    postId: string;
    postUrl: string;
    postType: 'image' | 'video' | 'carousel' | 'reel';
    caption: string;
    hashtags: string[];
    mentions: string[];
    likesCount: number;
    commentsCount: number;
    viewsCount: number | null;
    postedDate: string;
    thumbnailUrl: string;
    locationTag: string;
    isSponsored: boolean;
    productTagsFlag: boolean;
    username: string;
    scrapedAt: string;
}
