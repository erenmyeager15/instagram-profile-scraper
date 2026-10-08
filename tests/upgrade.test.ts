import assert from 'node:assert/strict';
import test from 'node:test';
import { count, mergeInstagramResults, parseInstagramHtml, parseInstagramPayload, publicLink } from '../src/parsers.js';
import { normalizeUsername, validateInput } from '../src/input.js';
import { collectProfile, MAX_PROFILE_REQUESTS, type HttpRequest, type HttpResponse, type Requester } from '../src/collector.js';
import { appendSnapshot, compareProfile, enrichProfile, previousSnapshot, readState, summarizeActivity, MAX_HISTORY_BYTES } from '../src/insights.js';
import { runProfiles, type Dependencies, type RunSummary } from '../src/runner.js';
import type { MonitorSession } from '../src/monitor.js';
import type { InstagramResult, ProfileRecord } from '../src/types.js';

function payload(extra: Record<string, unknown> = {}) {
    return { data: { user: { username: 'demo', id: '1', full_name: 'Demo', is_private: false, biography: 'Brand', external_url: '',
        edge_followed_by: { count: 100 }, edge_follow: { count: 10 }, edge_owner_to_timeline_media: { count: 2, edges: [] }, ...extra } } };
}
function result(extra: Record<string, unknown> = {}): InstagramResult { return parseInstagramPayload(payload(extra), 'demo')!; }
function profile(at = '2026-10-08T12:00:00Z'): ProfileRecord { return { ...result().profile, scrapedAt: at }; }
const html = (value = payload()): string => `<script type="application/json">${JSON.stringify(value)}</script>`;
const response = (body: string, statusCode = 200): HttpResponse => ({ body, statusCode, headers: {} });
function requester(responses: (HttpResponse | Error)[], calls: string[] = []): Requester {
    return async request => { calls.push(request.url); const next = responses.shift(); if (!next) throw new Error('Unexpected request'); if (next instanceof Error) throw next; return next; };
}
const noProxy = async () => undefined;
const running = () => false;

for (const [raw, expected] of [['@Demo', 'demo'], ['instagram.com/Demo/', 'demo'], ['https://www.instagram.com/demo/?hl=en', 'demo'],
    ['https://evil.example/instagram.com/demo', null], ['https://instagram.com.evil.example/demo/', null], ['https://instagram.com/p/ABC', null],
    ['https://instagram.com/demo/reels/', null], ['https://x@instagram.com/demo', null], ['stories', null], ['bad name', null]] as const) {
    test(`normalize profile input: ${raw}`, () => assert.equal(normalizeUsername(raw), expected));
}
test('deduplicates input, reports invalid values, keeps Residential default', () => {
    const input = validateInput({ usernames: ['@Demo', 'demo', 'not a handle'] });
    assert.deepEqual(input.usernames, ['demo']); assert.equal(input.invalidInputs, 1); assert.equal(input.duplicatesRemoved, 1);
    assert.deepEqual(input.proxy, { useApifyProxy: true, groups: ['RESIDENTIAL'] });
});
test('explicit no-proxy and custom proxy settings are honored', () => {
    assert.equal(validateInput({ usernames: ['demo'], proxyConfiguration: { useApifyProxy: false } }).proxy.useApifyProxy, false);
    assert.deepEqual(validateInput({ usernames: ['demo'], proxyConfiguration: { proxyUrls: ['http://proxy.example:80'] } }).proxy.proxyUrls, ['http://proxy.example:80']);
    assert.equal(validateInput({ usernames: ['demo'], proxyConfiguration: { useApifyProxy: true, apifyProxyCountry: 'US' } }).proxy.countryCode, 'US');
});
for (const bad of [{ usernames: 'demo' }, { usernames: [1] }, { usernames: Array.from({ length: 51 }, (_, i) => `user${i}`) },
    { usernames: ['demo'], includeRecentPosts: 'true' }, { usernames: ['demo'], maxRecentPosts: 13 },
    { usernames: ['demo'], maxRunSeconds: 900 }, { usernames: ['demo'], monitorStoreName: '../x' }]) {
    test(`rejects malformed input ${JSON.stringify(bad).slice(0, 70)}`, () => assert.throws(() => validateInput(bad as never)));
}
test('empty monitor name disables persistence', () => assert.equal(validateInput({ usernames: ['demo'], monitorStoreName: '' }).monitorStoreName, ''));
for (const value of [undefined, null, '', -1, NaN, Infinity, true, 'junk', 1.5]) {
    test(`invalid numeric count is unknown: ${String(value)}`, () => assert.equal(count(value), null));
}
test('genuine zero stays zero and missing does not become zero', () => {
    assert.equal(count(0), 0); assert.equal(result({ follower_count: 0, edge_followed_by: undefined }).profile.followers, 0);
    assert.equal(result({ edge_follow: undefined }).profile.following, null);
});
test('mismatched direct API username is rejected', () => assert.equal(parseInstagramPayload(payload({ username: 'other' }), 'demo'), null));
test('private and privacy-unknown profiles expose no post sample', () => {
    for (const is_private of [true, undefined]) assert.deepEqual(result({ is_private, edge_owner_to_timeline_media: { count: 2, edges: [{ node: { shortcode: 'ONE' } }] } }).posts, []);
});
test('malformed optional post array/date never discards profile', () => {
    assert.equal(result({ edge_owner_to_timeline_media: { count: 2, edges: {} } }).profile.username, 'demo');
    const data = result({ edge_owner_to_timeline_media: { count: 2, edges: [{ node: { shortcode: 'ONE', taken_at_timestamp: 9e15 } }, null] } });
    assert.equal(data.posts[0].postedDate, '');
});
test('post product type is not a product-tag flag; missing likes are unknown', () => {
    const post = result({ edge_owner_to_timeline_media: { count: 1, edges: [{ node: { shortcode: 'ONE', product_type: 'clips' } }] } }).posts[0];
    assert.equal(post.postType, 'reel'); assert.equal(post.productTagsFlag, null); assert.equal(post.likesCount, null);
});
test('duplicate recent posts collapse and cap at 12', () => {
    const data = result({ edge_owner_to_timeline_media: { count: 20, edges: Array.from({ length: 24 }, (_, i) => ({ node: { shortcode: `POST${i % 20}` } })) } });
    assert.equal(data.posts.length, 12);
});
test('multiple safe bio links and domains are deduplicated without crawling', () => {
    const data = result({ external_url: 'https://brand.example', bio_links: [{ url: 'https://brand.example/' },
        { url: 'https://l.instagram.com/?u=https%3A%2F%2Fshop.example%2F' }, { url: 'javascript:alert(1)' }] });
    assert.deepEqual(data.profile.externalDomains, ['brand.example', 'shop.example']); assert.equal(data.profile.externalLinks.length, 2);
    assert.equal(publicLink('https://user:password@example.com'), null);
});
test('reordered meta attributes and HTML entities parse correctly', () => {
    const data = parseInstagramHtml('<meta content="Demo &amp; Co (@demo)" property="og:title"><meta content="2.5M Followers, 2 Following, 12 Posts" property="og:description">', 'demo')!;
    assert.equal(data.profile.fullName, 'Demo & Co'); assert.equal(data.profile.followers, 2_500_000);
    assert.equal(data.profile.metricPrecision.followers, 'rounded'); assert.equal(data.profile.isPrivate, null);
});
test('near-match metadata username is not accepted', () => assert.equal(parseInstagramHtml('<meta property="og:title" content="D (@demo2)"><meta property="og:description" content="2 Followers, 1 Following, 1 Posts">', 'demo'), null));
test('merge preserves exact zero instead of choosing fallback nonzero', () => {
    const primary = result({ edge_follow: { count: 0 } }); const fallback = result({ edge_follow: { count: 10 } });
    assert.equal(mergeInstagramResults(primary, fallback)?.profile.following, 0);
});
test('a private fallback overrides a public primary', () => assert.equal(mergeInstagramResults(result(), result({ is_private: true }))?.profile.isPrivate, true));

test('conflicting source IDs cannot be saved as a confirmed public identity', () => {
    const merged = mergeInstagramResults(result(), result({ id: '2' }))!;
    assert.equal(merged.profile.isPrivate, null); assert.deepEqual(merged.posts, []);
    assert.ok(merged.profile.qualityFlags.includes('SOURCE_ID_CONFLICT'));
    assert.equal(mergeInstagramResults(result(), result({ id: '2', is_private: true }))?.profile.isPrivate, true);
});
test('explicit empty primary bio links do not resurrect removed fallback links', () => {
    assert.deepEqual(mergeInstagramResults(result(), result({ external_url: 'https://old.example' }))?.profile.externalLinks, []);
    const missing = result({ external_url: undefined });
    assert.deepEqual(mergeInstagramResults(missing, result({ external_url: 'https://old.example' }))?.profile.externalLinks, ['https://old.example/']);
});
test('a mismatched fallback cannot contaminate a profile', () => {
    const other = parseInstagramPayload(payload({ username: 'other' }), 'other')!;
    assert.equal(mergeInstagramResults(result(), other)?.profile.username, 'demo');
});
test('complete structured HTML uses one request, without metadata call', async () => {
    const calls: string[] = []; const lookup = await collectProfile('demo', requester([response(html())], calls), noProxy, running);
    assert.equal(lookup.status, 'OK'); assert.equal(calls.length, 1); assert.equal(lookup.requests, 1);
});
test('requested sample uses optional metadata call when HTML has no posts', async () => {
    const lookup = await collectProfile('demo', requester([response(html()), response(JSON.stringify(payload({
        edge_owner_to_timeline_media: { count: 2, edges: [{ node: { shortcode: 'NEW', like_count: 5, comment_count: 1 } }] },
    })))]), noProxy, running, true);
    assert.equal(lookup.status, 'OK'); assert.equal(lookup.requests, 2); assert.equal(lookup.result?.posts.length, 1);
});
test('an existing HTML post sample avoids another source request', async () => {
    const lookup = await collectProfile('demo', requester([response(html(payload({ edge_owner_to_timeline_media: {
        count: 2, edges: [{ node: { shortcode: 'NEW' } }],
    } })))]), noProxy, running, true);
    assert.equal(lookup.status, 'OK'); assert.equal(lookup.requests, 1);
});
test('optional endpoint JSON failure preserves usable HTML profile', async () => {
    const lookup = await collectProfile('demo', requester([response(html(payload({ edge_follow: undefined }))), response('<html>login</html>')]), noProxy, running);
    assert.equal(lookup.status, 'OK'); assert.equal(lookup.result?.profile.followers, 100); assert.equal(lookup.requests, 2);
});
test('optional endpoint timeout preserves usable HTML profile', async () => {
    const lookup = await collectProfile('demo', requester([response(html(payload({ edge_follow: undefined }))), new Error('Timeout')]), noProxy, running);
    assert.equal(lookup.status, 'OK');
});
test('private HTML ends lookup without endpoint or second attempt', async () => {
    const lookup = await collectProfile('demo', requester([response(html(payload({ is_private: true })))]), noProxy, running);
    assert.equal(lookup.status, 'PRIVATE'); assert.equal(lookup.requests, 1); assert.equal(lookup.result, null);
});
test('404 unavailable is terminal and uncharged', async () => {
    const lookup = await collectProfile('demo', requester([response('', 404)]), noProxy, running);
    assert.equal(lookup.status, 'UNAVAILABLE'); assert.equal(lookup.requests, 1);
});
test('403 page responses use at most two page requests and no metadata call', async () => {
    let sessions = 0;
    const calls: string[] = [];
    const lookup = await collectProfile('demo', requester([response('', 403), response('', 403)], calls), async () => { sessions++; return undefined; }, running);
    assert.equal(lookup.status, 'BLOCKED'); assert.equal(lookup.requests, 2); assert.equal(sessions, 2);
    assert.deepEqual(calls, ['https://www.instagram.com/demo/', 'https://www.instagram.com/demo/']);
});
test('fallback session can recover a blocked first session', async () => {
    const lookup = await collectProfile('demo', requester([response('', 403), response(html())]), noProxy, running);
    assert.equal(lookup.status, 'OK'); assert.equal(lookup.attempts, 2); assert.equal(lookup.requests, 2);
});
for (const status of [401, 429]) {
    test(`HTTP ${status} stops immediately without API or session rotation`, async () => {
        const lookup = await collectProfile('demo', requester([response('', status)]), noProxy, running);
        assert.equal(lookup.status, 'BLOCKED'); assert.equal(lookup.requests, 1); assert.equal(lookup.attempts, 1);
    });
}
test('network failures retry the page only, not the optional metadata endpoint', async () => {
    const lookup = await collectProfile('demo', requester([new Error('Network'), new Error('Network')]), noProxy, running);
    assert.equal(lookup.status, 'NO_DATA'); assert.equal(lookup.requests, 2);
});
test('metadata-only cannot prove privacy and is not billed', async () => {
    const meta = '<meta property="og:title" content="Demo (@demo)"><meta property="og:description" content="100 Followers, 2 Following, 1 Posts">';
    const lookup = await collectProfile('demo', requester([response(meta), response('{}'), response(meta), response('{}')]), noProxy, running);
    assert.equal(lookup.status, 'PRIVACY_UNKNOWN'); assert.equal(lookup.result, null);
});
test('deadline stops lookup before source requests', async () => {
    const lookup = await collectProfile('demo', requester([]), noProxy, () => true);
    assert.equal(lookup.status, 'TIME_LIMIT'); assert.equal(lookup.requests, 0);
});
test('source-stage traces distinguish redirects and blocks without retaining headers or bodies', async () => {
    const secret = 'do-not-log-cookie-password';
    const lookup = await collectProfile('demo', requester([
        { statusCode: 302, body: secret, headers: { location: `https://www.instagram.com/accounts/login/?next=${secret}`, 'set-cookie': secret, 'content-type': 'text/html' } },
    ]), noProxy, running);
    assert.equal(lookup.status, 'BLOCKED'); assert.equal(lookup.traces.length, 1);
    assert.deepEqual(lookup.traces.map(row => row.statusCode), [302]);
    assert.deepEqual(lookup.traces.map(row => row.stage), ['profile-page']);
    assert.equal(lookup.traces[0].redirect, 'login'); assert.equal(lookup.traces[0].contentKind, 'html');
    assert.equal(lookup.traces[0].bodyBytes, Buffer.byteLength(secret));
    assert.ok(!JSON.stringify(lookup.traces).includes(secret));
});
test('request errors are classified without raw credential-bearing messages', async () => {
    const lookup = await collectProfile('demo', requester([new Error('Timeout password-secret'), new Error('Profile response exceeded safety size.'),
    ]), noProxy, running);
    assert.deepEqual(lookup.traces.map(row => row.error), ['TIMEOUT', 'RESPONSE_TOO_LARGE']);
    assert.ok(!JSON.stringify(lookup.traces).includes('password'));
    const network = await collectProfile('demo', requester([new Error('Network http://user:password@proxy.example'), response('', 429)]), noProxy, running);
    assert.equal(network.traces[0].error, 'NETWORK_ERROR'); assert.ok(!JSON.stringify(network.traces).includes('password'));
});
test('HTML and metadata share one browser session; retry replaces the session', async () => {
    const sessions: object[] = [];
    const lookup = await collectProfile('demo', async options => { sessions.push(options.sessionToken!); return response('{}'); }, noProxy, running);
    assert.equal(lookup.requests, 4); assert.ok(sessions[0]);
    assert.equal(sessions[0], sessions[1]); assert.equal(sessions[2], sessions[3]); assert.notEqual(sessions[0], sessions[2]);
});
test('same-profile canonical redirect reuses proxy, cookies and browser identity', async () => {
    const calls: HttpRequest[] = [];
    const sequence: HttpResponse[] = [
        { statusCode: 301, body: '', headers: { location: 'https://instagram.com/Demo/?hl=en', 'set-cookie': [
            'mid=redirect-cookie; Domain=.instagram.com; Path=/; Secure', 'wrong=no; Domain=other.example; Path=/',
        ] } },
        { statusCode: 200, body: html(payload({ edge_follow: undefined })), headers: { 'set-cookie': [
            'csrftoken=page-csrf; Domain=.instagram.com; Path=/; Secure', 'local=page-only; Path=/Demo/',
        ] } },
        response(JSON.stringify(payload())),
    ];
    const lookup = await collectProfile('demo', async options => { calls.push(options); return sequence.shift()!; }, async () => 'http://proxy.test:80', running);
    assert.equal(lookup.status, 'OK'); assert.equal(calls.length, 3);
    assert.equal(calls[1].url, 'https://instagram.com/Demo/?hl=en'); assert.equal(calls[1].headers.cookie, 'mid=redirect-cookie');
    assert.equal(calls[2].headers.cookie, 'mid=redirect-cookie; csrftoken=page-csrf');
    assert.equal(calls[2].headers['x-csrftoken'], 'page-csrf'); assert.equal(calls[2].headers.referer, calls[1].url);
    assert.ok(calls.every(call => call.proxyUrl === calls[0].proxyUrl && call.sessionToken === calls[0].sessionToken));
    assert.ok(!JSON.stringify(lookup.traces).includes('redirect-cookie'));
});
test('cookie updates replace old values and deletion does not leak stale CSRF', async () => {
    const calls: HttpRequest[] = [];
    const sequence: HttpResponse[] = [
        { statusCode: 302, body: '', headers: { location: '/Demo/', 'set-cookie': [
            'csrftoken=old; Path=/; Secure', 'mid=keep; Path=/; Secure',
        ] } },
        { statusCode: 200, body: html(payload({ edge_follow: undefined })), headers: { 'set-cookie': [
            'csrftoken=gone; Path=/; Max-Age=0', 'mid=updated; Path=/; Secure',
        ] } },
        response(JSON.stringify(payload())),
    ];
    const lookup = await collectProfile('demo', async options => { calls.push(options); return sequence.shift()!; }, noProxy, running);
    assert.equal(lookup.status, 'OK'); assert.equal(calls[2].headers.cookie, 'mid=updated');
    assert.equal(calls[2].headers['x-csrftoken'], undefined);
});
for (const location of ['/other/', 'https://evil.example/demo/', 'https://www.instagram.com.evil.example/demo/',
    'https://user:secret@www.instagram.com/demo/', 'http://www.instagram.com/demo/', 'https://www.instagram.com:444/demo/',
    '/demo/?next=https://evil.example', '/demo/?hl=en&hl=fr', '/demo/?hl=bad-language', '/demo/']) {
    test(`unsafe or looping redirect is not followed: ${location}`, async () => {
        const lookup = await collectProfile('demo', requester([{ statusCode: 302, body: '', headers: { location } }]), noProxy, running);
        assert.equal(lookup.status, 'NO_DATA'); assert.equal(lookup.requests, 1);
    });
}
for (const location of ['/accounts/login/', '/challenge/ABC/', '/checkpoint/']) {
    test(`login/challenge redirect is not followed: ${location}`, async () => {
        const lookup = await collectProfile('demo', requester([{ statusCode: 302, body: '', headers: { location } }]), noProxy, running);
        assert.equal(lookup.status, 'BLOCKED'); assert.equal(lookup.requests, 1);
    });
}
test('canonical redirect chain is bounded to one hop without silently following login', async () => {
    const lookup = await collectProfile('demo', requester([
        { statusCode: 301, body: '', headers: { location: '/Demo/' } },
        { statusCode: 302, body: '', headers: { location: 'https://instagram.com/demo/' } },
    ]), noProxy, running);
    assert.equal(lookup.status, 'NO_DATA'); assert.equal(lookup.requests, 2);
});
test('canonical redirect and fresh-session fallback still share a four-request ceiling', async () => {
    const lookup = await collectProfile('demo', requester([
        { statusCode: 301, body: '', headers: { location: '/Demo/' } }, response('{}'), response('{}'), response(html()),
    ]), noProxy, running, true);
    assert.equal(lookup.status, 'OK'); assert.equal(lookup.requests, MAX_PROFILE_REQUESTS);
});
test('deadline between canonical hops prevents another request', async () => {
    let stop = false;
    const lookup = await collectProfile('demo', async () => { stop = true; return { statusCode: 301, body: '', headers: { location: '/Demo/' } }; }, noProxy, () => stop);
    assert.equal(lookup.status, 'TIME_LIMIT'); assert.equal(lookup.requests, 1);
});
test('rate-limited optional metadata keeps usable public HTML without another session', async () => {
    const lookup = await collectProfile('demo', requester([response(html(payload({ edge_follow: undefined }))), response('', 429)]), noProxy, running);
    assert.equal(lookup.status, 'OK'); assert.equal(lookup.requests, 2); assert.equal(lookup.result?.profile.followers, 100);
});
test('rate-limited metadata with no usable profile stops visibly without further sessions', async () => {
    const lookup = await collectProfile('demo', requester([response('{}'), response('', 429)]), noProxy, running);
    assert.equal(lookup.status, 'BLOCKED'); assert.equal(lookup.requests, 2); assert.equal(lookup.result, null);
});
test('discarded response bodies are explicitly marked, not reported as full transfer bytes', async () => {
    const lookup = await collectProfile('demo', requester([{ ...response('', 429), bodyDiscarded: true }]), noProxy, running);
    assert.equal(lookup.traces[0].bodyBytes, 0); assert.equal(lookup.traces[0].bodyDiscarded, true);
});
test('activity uses only posts with both engagement counts, and labels sample', () => {
    const data = result({ edge_owner_to_timeline_media: { count: 3, edges: [
        { node: { shortcode: 'A', edge_liked_by: { count: 10 }, edge_media_to_comment: { count: 2 }, taken_at_timestamp: 1_700_000_000 } },
        { node: { shortcode: 'B', edge_liked_by: { count: 20 }, edge_media_to_comment: { count: 4 }, taken_at_timestamp: 1_700_604_800 } },
        { node: { shortcode: 'C' } },
    ] } });
    const summary = summarizeActivity(data.posts, 100, 'exact', data.profile.scrapedAt);
    assert.equal(summary.sampledPosts, 3); assert.equal(summary.engagementPosts, 2); assert.equal(summary.engagementRatePercent, 18);
    assert.equal(summary.medianInteractions, 18); assert.equal(summary.samplePostsPerWeek, 1);
    assert.equal(summarizeActivity(data.posts, 100, 'rounded', data.profile.scrapedAt).engagementRatePercent, null);
});
test('no posts means unknown activity, not zero engagement', () => {
    const data = enrichProfile(result(), true, 6); assert.equal(data.activity?.sampleStatus, 'NOT_EXPOSED');
    assert.equal(data.activity?.averageLikes, null); assert.equal(data.activity?.engagementRatePercent, null);
    assert.equal(enrichProfile(result(), false, 6).recentPosts, undefined);
});
test('watchlist first, unchanged, changed and threshold flags', () => {
    const previous = profile('2026-10-07T12:00:00Z'); const current = profile();
    assert.equal(compareProfile(current, undefined, 5).status, 'FIRST_SEEN');
    assert.equal(compareProfile(current, previous, 5).status, 'UNCHANGED');
    current.followers = 110; current.bio = 'New brand';
    const change = compareProfile(current, previous, 5);
    assert.equal(change.status, 'CHANGED'); assert.equal(change.followerChange, 10); assert.equal(change.followerChangePercent, 10);
    assert.equal(change.followerThresholdExceeded, true); assert.equal(change.elapsedHours, 24); assert.equal(change.bioChanged, true);
});
test('rounded or missing counts never create numerical growth alerts', () => {
    const previous = profile('2026-10-07T12:00:00Z'); const current = profile();
    current.followers = 200; current.metricPrecision.followers = 'rounded';
    const change = compareProfile(current, previous, 5); assert.equal(change.status, 'NOT_COMPARABLE');
    assert.equal(change.followerChange, null); assert.equal(change.followerThresholdExceeded, false);
});
test('zero baseline prevents infinite percentage while still reporting count change', () => {
    const previous = profile('2026-10-07T12:00:00Z'); previous.followers = 0;
    const change = compareProfile(profile(), previous, 5); assert.equal(change.followerChange, 100); assert.equal(change.followerChangePercent, null);
});
test('missing bio is not a deletion; missing links are not removed links', () => {
    const previous = profile('2026-10-07T12:00:00Z'); const current = profile();
    current.fieldAvailability = { bio: false, externalLinks: false }; current.bio = '';
    const change = compareProfile(current, previous, 5); assert.equal(change.bioChanged, null); assert.equal(change.linksChanged, null);
});
test('changed profile ID or non-forward timestamp prevents misleading comparisons', () => {
    const old = profile('2026-10-07T12:00:00Z'); const current = profile(); current.profileId = '2';
    assert.deepEqual(compareProfile(current, old, 5).reasons, ['PROFILE_ID_CHANGED']);
    assert.deepEqual(compareProfile(old, current, 5).reasons, ['NON_FORWARD_OBSERVATION']);
});
test('history bounds observations, excludes stale comparisons and protects object keys', () => {
    const state = readState(null);
    for (let i = 1; i <= 12; i++) appendSnapshot(state, profile(`2026-09-${String(i).padStart(2, '0')}T12:00:00Z`));
    assert.equal(state.profiles.demo.length, 10); assert.equal(previousSnapshot(state, 'demo', '2026-10-20T12:00:00Z'), undefined);
    const special = profile(); special.username = '__proto__'; appendSnapshot(state, special);
    assert.equal(state.profiles.__proto__.length, 1); assert.equal(previousSnapshot(state, 'constructor', special.scrapedAt), undefined);
    assert.equal(readState(JSON.parse(JSON.stringify(state))).profiles.demo.length, 10);
});
test('history profile count is bounded and the current snapshot is retained on a timestamp tie', () => {
    const state = readState(null);
    for (let i = 0; i <= 500; i++) { const p = profile(); p.username = `brand${i}`; appendSnapshot(state, p); }
    assert.equal(Object.keys(state.profiles).length, 500); assert.ok(state.profiles.brand500);
});
test('history evicts old observations to respect the serialized byte bound', () => {
    const state = readState(null);
    const old = profile('2026-10-07T12:00:00Z'); old.bio = 'x'.repeat(1_100_000); appendSnapshot(state, old);
    const current = profile(); current.bio = 'y'.repeat(1_100_000); appendSnapshot(state, current);
    assert.equal(state.profiles.demo.length, 1); assert.equal(state.profiles.demo[0].bio[0], 'y');
    assert.ok(Buffer.byteLength(JSON.stringify(state)) <= MAX_HISTORY_BYTES);
    assert.equal(readState(state).profiles.demo.length, 1);
});
test('one oversized observation is rejected without corrupting the existing baseline', () => {
    const state = readState(null); appendSnapshot(state, profile('2026-10-07T12:00:00Z'));
    const oversized = profile(); oversized.bio = 'x'.repeat(MAX_HISTORY_BYTES);
    assert.throws(() => appendSnapshot(state, oversized), /size bound/);
    assert.equal(state.profiles.demo.length, 1); assert.equal(state.profiles.demo[0].scrapedAt, '2026-10-07T12:00:00Z');
});
test('oversized stored history and malformed URL/ID types are rejected before source work', () => {
    const state = readState(null); appendSnapshot(state, profile());
    const invalid = structuredClone(state); invalid.profiles.demo[0].externalLinks = [5 as never];
    assert.throws(() => readState(invalid), /invalid/);
    const wrongId = structuredClone(state); wrongId.profiles.demo[0].profileId = 2 as never;
    assert.throws(() => readState(wrongId), /invalid/);
    state.profiles.demo[0].bio = 'x'.repeat(MAX_HISTORY_BYTES);
    assert.throws(() => readState(state), /safety bound/);
});
test('links are compared as a set, not source order', () => {
    const old = profile('2026-10-07T12:00:00Z'); old.externalLinks = ['https://a.example/', 'https://b.example/'];
    const current = profile(); current.externalLinks = [...old.externalLinks].reverse();
    assert.equal(compareProfile(current, old, 5).linksChanged, false);
});
for (const state of [{ version: 2, profiles: {} }, { version: 1, profiles: { demo: [] } }, { version: 1, profiles: { demo: [{}] } }]) {
    test(`invalid monitor state rejected ${JSON.stringify(state)}`, () => assert.throws(() => readState(state)));
}

function fixture(overrides: Partial<Dependencies> = {}) {
    const reports: RunSummary[] = []; const rows: ProfileRecord[] = []; const events: string[] = [];
    const monitor: MonitorSession = { state: readState(null), renew: async () => { events.push('renew'); },
        commit: async () => { events.push('commit'); }, release: async () => { events.push('release'); } };
    const deps: Dependencies = { request: requester([response(html())]), newProxy: noProxy, stopped: running, canSave: () => true,
        save: async row => { rows.push(row); events.push('save'); return { saved: true, exhausted: false }; },
        report: async summary => { reports.push(structuredClone(summary)); events.push('report'); }, monitor, ...overrides };
    return { deps, reports, rows, events, monitor };
}
test('runner saves/charges one profile, exports report then commits history', async () => {
    const f = fixture(); const summary = await runProfiles(validateInput({ usernames: ['demo'] }), f.deps);
    assert.equal(summary.saved, 1); assert.equal(summary.historyCommitted, true); assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].changes?.status, 'FIRST_SEEN');
    assert.ok(f.events.indexOf('save') < f.events.indexOf('report')); assert.ok(f.events.indexOf('report') < f.events.indexOf('commit'));
    assert.equal(f.events.filter(e => e === 'release').length, 1);
});
test('exhausted budget causes zero source requests and no history commit', async () => {
    const f = fixture({ canSave: () => false }); const summary = await runProfiles(validateInput({ usernames: ['demo'] }), f.deps);
    assert.equal(summary.status, 'BUDGET_LIMIT'); assert.equal(summary.requests, 0); assert.equal(f.rows.length, 0); assert.ok(!f.events.includes('commit'));
});
test('save trimmed by budget does not advance history', async () => {
    const f = fixture({ save: async () => ({ saved: false, exhausted: true }) });
    const summary = await runProfiles(validateInput({ usernames: ['demo'] }), f.deps);
    assert.equal(summary.saved, 0); assert.equal(summary.status, 'BUDGET_LIMIT'); assert.equal(Object.keys(f.monitor.state.profiles).length, 0);
});

test('charge limit reached on the final saved profile reports complete', async () => {
    const f = fixture({ save: async () => ({ saved: true, exhausted: true }) });
    const summary = await runProfiles(validateInput({ usernames: ['demo'] }), f.deps);
    assert.equal(summary.saved, 1); assert.equal(summary.status, 'COMPLETE');
    assert.equal(summary.lookups[0].status, 'OK'); assert.equal(summary.historyCommitted, true);
});

test('charge limit reached before the last profile stops further requests', async () => {
    const f = fixture({ save: async () => ({ saved: true, exhausted: true }) });
    const summary = await runProfiles(validateInput({ usernames: ['demo', 'other'] }), f.deps);
    assert.equal(summary.saved, 1); assert.equal(summary.status, 'BUDGET_LIMIT');
    assert.equal(summary.requests, 1); assert.equal(summary.lookups[1].status, 'BUDGET_LIMIT');
});
test('storage failure is fatal and never advances history', async () => {
    const f = fixture({ save: async () => { throw new Error('Storage unavailable'); } });
    await assert.rejects(runProfiles(validateInput({ usernames: ['demo'] }), f.deps), /Storage unavailable/);
    assert.ok(!f.events.includes('commit')); assert.equal(f.reports.at(-1)?.lookups[0].status, 'STORAGE_ERROR');
});
test('report export failure cannot advance baseline', async () => {
    const f = fixture({ report: async () => { throw new Error('Export unavailable'); } });
    await assert.rejects(runProfiles(validateInput({ usernames: ['demo'] }), f.deps), /Export unavailable/);
    assert.ok(!f.events.includes('commit')); assert.ok(f.events.includes('release'));
});
test('ambiguous timed-out history write is explicitly reported as unknown', async () => {
    const f = fixture(); f.monitor.commit = async () => { throw new Error('Write timed out'); };
    await assert.rejects(runProfiles(validateInput({ usernames: ['demo'] }), f.deps), /Write timed out/);
    assert.equal(f.reports.at(-1)?.historyCommitted, 'unknown');
});
test('all-private run fails visibly with zero profile charges', async () => {
    const f = fixture({ request: requester([response(html(payload({ is_private: true })))]) });
    await assert.rejects(runProfiles(validateInput({ usernames: ['demo'] }), f.deps), /No confirmed public/);
    assert.equal(f.rows.length, 0); assert.equal(f.reports.at(-1)?.lookups[0].status, 'PRIVATE');
});
test('deadline is a partial stop, not a fake successful profile', async () => {
    const f = fixture({ stopped: () => true }); const summary = await runProfiles(validateInput({ usernames: ['demo'] }), f.deps);
    assert.equal(summary.status, 'TIME_LIMIT'); assert.equal(summary.saved, 0); assert.equal(summary.requests, 0);
});
test('two consecutive blocked targets stop a roster, with skipped targets distinct and uncharged', async () => {
    const f = fixture({ request: async () => response('', 403) });
    await assert.rejects(runProfiles(validateInput({ usernames: ['demo', 'other', 'third', 'fourth'] }), f.deps), /No confirmed public/);
    const report = f.reports.at(-1)!;
    assert.equal(report.requests, 4); assert.equal(report.saved, 0); assert.equal(f.rows.length, 0);
    assert.deepEqual(report.lookups.map(row => row.status), ['BLOCKED', 'BLOCKED', 'SOURCE_BLOCKED', 'SOURCE_BLOCKED']);
    assert.equal(report.lookups[2].attempts, 0); assert.equal(report.lookups[2].requests, 0); assert.deepEqual(report.lookups[2].traces, []);
    assert.equal(report.historyCommitted, false); assert.ok(!f.events.includes('commit'));
});
test('a non-blocked lookup resets the roster block counter', async () => {
    const f = fixture({ request: requester([response('', 429), response('', 404), response('', 429), response(html())]) });
    const summary = await runProfiles(validateInput({ usernames: ['first', 'missing', 'blocked', 'demo'] }), f.deps);
    assert.equal(summary.status, 'PARTIAL'); assert.equal(summary.requests, 4); assert.equal(summary.saved, 1);
    assert.deepEqual(summary.lookups.map(row => row.status), ['BLOCKED', 'UNAVAILABLE', 'BLOCKED', 'OK']);
});
test('partial source circuit stop retains saved output and advances only that history', async () => {
    const f = fixture({ request: requester([response(html()), response('', 429), response('', 429)]) });
    const summary = await runProfiles(validateInput({ usernames: ['demo', 'other', 'third', 'fourth'] }), f.deps);
    assert.equal(summary.status, 'PARTIAL'); assert.equal(summary.saved, 1); assert.equal(summary.requests, 3);
    assert.equal(summary.lookups.at(-1)?.status, 'SOURCE_BLOCKED'); assert.equal(summary.historyCommitted, true);
    assert.deepEqual(Object.keys(f.monitor.state.profiles), ['demo']);
});
