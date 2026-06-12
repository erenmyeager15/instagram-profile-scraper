import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { cleanInstagramUrl, handleProfilePage } from './routes.js';
import type { ActorInput } from './types.js';

const MAINTENANCE_MESSAGE = 'Under maintenance. This Actor is temporarily unavailable and no data was collected.';

Actor.main(async () => {
    await Actor.setStatusMessage(MAINTENANCE_MESSAGE);
    log.warning(MAINTENANCE_MESSAGE);
    return;

    const input = (await Actor.getInput()) as ActorInput;
    const {
        usernames,
        maxPostsPerProfile = 12,
        includeReels = true,
        includeCarousels = true,
        proxyConfiguration: proxyConfig,
    } = input ?? {};

    if (!usernames || usernames.length === 0) {
        throw new Error('At least one username or profile URL must be provided.');
    }

    const profileDataset = await Actor.openDataset();
    const postDataset = await Actor.openDataset('posts');

    const proxyConfiguration = proxyConfig?.useApifyProxy
        ? await Actor.createProxyConfiguration({
              groups: proxyConfig.apifyProxyGroups?.length ? proxyConfig.apifyProxyGroups : ['RESIDENTIAL'],
          })
        : proxyConfig?.proxyUrls?.length
          ? await Actor.createProxyConfiguration({ proxyUrls: proxyConfig.proxyUrls })
          : undefined;

    const scrapedPostIds = new Set<string>();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 3,
        minConcurrency: 1,
        requestHandlerTimeoutSecs: 300,
        retryOnBlocked: true,
        maxRequestRetries: 3,
        sessionPoolOptions: {
            maxPoolSize: 10,
            sessionOptions: {
                maxUsageCount: 10,
            },
        },
        preNavigationHooks: [
            async ({ page }) => {
                await page.setViewportSize({ width: 1366, height: 768 });
                // Fast-fail locator actions: missing elements should not block for the
                // 30s default, which otherwise stacks up and times out the handler.
                page.setDefaultTimeout(8000);
            },
        ],
        requestHandler: async (context) => {
            const { page } = context;
            const delay = 2000 + Math.random() * 4000;
            await page.waitForTimeout(delay);

            await handleProfilePage(context, {
                profileDataset,
                postDataset,
                scrapedPostIds,
                maxPostsPerProfile,
                includeReels,
                includeCarousels,
            });
        },
        failedRequestHandler: async ({ request, log: ctxLog }) => {
            ctxLog.error(`Request failed after retries: ${request.url}`);
        },
    });

    const requests = usernames.map((u) => {
        const clean = cleanInstagramUrl(u);
        return `https://www.instagram.com/${clean}/`;
    });

    await crawler.run(requests);

    log.info('Scraping complete.');
    await Actor.exit();
});
