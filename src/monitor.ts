import { Actor } from 'apify';
import { createHash, randomUUID } from 'node:crypto';
import { readState, type MonitorState } from './insights.js';

export interface MonitorSession {
    state: MonitorState;
    renew(): Promise<void>;
    commit(): Promise<void>;
    release(): Promise<void>;
}
export async function openMonitor(name: string): Promise<MonitorSession> {
    if (!Actor.isAtHome()) throw new Error('Persistent watchlists require an Apify platform run.');
    // Run-initiator credentials only. No owner token, personal-contact data, or cross-customer state.
    const client = Actor.newClient({ maxRetries: 0, timeoutSecs: 20 });
    const suffix = createHash('sha256').update(name).digest('hex').slice(0, 32);
    const store = await client.keyValueStores().getOrCreate(`ig-watch-${suffix}`);
    const queue = await client.requestQueues().getOrCreate(`ig-watch-lock-${suffix}`);
    const queueClient = client.requestQueue(queue.id, { clientKey: randomUUID().replace(/-/g, '') });
    const item = await queueClient.addRequest({ uniqueKey: 'ig-writer-v1', url: 'https://www.instagram.com/' });
    if (item.wasAlreadyHandled) throw new Error('Watchlist lock is invalid; choose a new monitorStoreName.');
    const lease = await queueClient.listAndLockHead({ lockSecs: 120, limit: 1 });
    const lock = lease.items.find(entry => entry.id === item.requestId)?.id;
    if (!lock) throw new Error('This watchlist is being updated by another run; wait until it finishes.');
    const storeClient = client.keyValueStore(store.id);
    try {
        const session: MonitorSession = {
            state: readState((await storeClient.getRecord('STATE'))?.value ?? null),
            renew: async () => { await queueClient.prolongRequestLock(lock, { lockSecs: 120 }); },
            commit: async () => {
                await session.renew();
                await storeClient.setRecord({ key: 'STATE', value: JSON.stringify(session.state), contentType: 'application/json' },
                    { timeoutSecs: 20, doNotRetryTimeouts: true });
            },
            release: async () => { await queueClient.deleteRequestLock(lock); },
        };
        return session;
    } catch (error) {
        await queueClient.deleteRequestLock(lock).catch(() => undefined);
        throw error;
    }
}
