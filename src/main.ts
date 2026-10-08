import { Actor, log } from 'apify';
import { randomUUID } from 'node:crypto';
import { validateInput } from './input.js';
import { openMonitor } from './monitor.js';
import { runProfiles } from './runner.js';
import { requestProfile } from './http.js';
import type { ActorInput } from './types.js';

Actor.main(async () => {
    const input = validateInput((await Actor.getInput<ActorInput>()) ?? { usernames: [] });
    const proxyConfiguration = input.proxy.useApifyProxy || input.proxy.proxyUrls?.length
        ? await Actor.createProxyConfiguration(input.proxy) : undefined;
    const charging = Actor.getChargingManager();
    const canSave = () => charging.calculateMaxEventChargeCountWithinLimit('profile-scraped') >= 1;
    const start = Date.now();
    const stopped = () => Date.now() - start >= input.maxRunSeconds * 1000;
    // Acquire named-history access before making source requests; overlapping runs do not scrape then discover a lock conflict.
    await Actor.setStatusMessage(`Checking ${input.usernames.length} public Instagram profile(s)`);
    const monitor = input.monitorStoreName && canSave() ? await openMonitor(input.monitorStoreName) : undefined;
    const summary = await runProfiles(input, {
        monitor, stopped, canSave,
        newProxy: async () => proxyConfiguration?.newUrl(randomUUID().replace(/-/g, '')),
        request: options => requestProfile(options, input.maxRunSeconds * 1000 - (Date.now() - start)),
        save: async profile => {
            const result = await Actor.pushData(profile, 'profile-scraped');
            return { saved: result.chargedCount > 0 || !result.eventChargeLimitReached, exhausted: result.eventChargeLimitReached };
        },
        report: async report => { await Actor.setValue('OUTPUT', report); },
    });
    log.info(`Saved ${summary.saved}/${summary.requested} profiles using ${summary.requests} HTTP requests. Status: ${summary.status}.`);
    await Actor.setStatusMessage(`${summary.status}: saved ${summary.saved}/${summary.requested} public profiles`);
});
