import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInstagramHtml, parseInstagramPayload } from '../src/parsers.js';
import { collectProfile } from '../src/collector.js';

const profile = (extra = {}) => ({ id: '17841400573960012', pk: '787132', username: 'natgeo',
    is_private: false, follower_count: 268408923, following_count: 150, all_media_count: 32001,
    biography: 'Public stories', bio_links: [], ...extra });
const relay = (user: unknown) => ({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: {
    require: [['RelayPrefetchedStreamCache', 'next', [], [null, { __bbox: { result: { data: { xig_user_by_username: user } } } }]]],
} }]]] });
const script = (value: unknown) => `<script type="application/json">${JSON.stringify(value)}</script>`;
const ownerIdentity = () => ({ id: profile().id, pk: profile().pk, username: 'natgeo' });
const timeline = (extra = {}, owner: Record<string, unknown> = ownerIdentity()) => ({ id: profile().id, pk: profile().pk,
    polaris_ordered_timeline_connection: { edges: [{ node: { id: 'post1', code: 'ABC', media_type: 8,
        caption: { text: 'Hello #earth' }, display_uri: 'https://example.com/public.jpg', user: owner } }] }, ...extra });

test('actual deep Relay wrapper yields exact public profile', () => {
    const result = parseInstagramPayload(relay(profile()), 'natgeo');
    assert.equal(result?.profile.isPrivate, false);
    assert.equal(result?.profile.followers, 268408923);
    assert.equal(result?.profile.metricPrecision.followers, 'exact');
});
for (const reverse of [false, true]) test(`separate Polaris timeline matches identity, order reversed=${reverse}`, () => {
    const parts = [script(relay(profile())), script(relay(timeline()))];
    const result = parseInstagramHtml((reverse ? parts.reverse() : parts).join(''), 'natgeo');
    assert.equal(result?.posts.length, 1);
    assert.equal(result?.posts[0].thumbnailUrl, 'https://example.com/public.jpg');
    assert.equal(result?.posts[0].postType, 'carousel');
    assert.equal(result?.posts[0].likesCount, null);
    assert.equal(result?.posts[0].commentsCount, null);
    assert.equal(result?.posts[0].postedDate, '');
});
for (const [label, value] of [
    ['wrong parent', timeline({ id: 'other' })],
    ['wrong owner id', timeline({}, { ...ownerIdentity(), id: 'other' })],
    ['wrong owner name', timeline({}, { ...ownerIdentity(), username: 'other' })],
    ['missing owner', timeline({}, {})],
] as const) test(`rejects ${label}`, () => {
    assert.equal(parseInstagramHtml(script(relay(profile())) + script(relay(value)), 'natgeo')?.posts.length, 0);
});
for (const privacy of [true, null]) test(`timeline cannot override privacy ${privacy}`, () => {
    const result = parseInstagramHtml(script(relay(profile({ is_private: privacy }))) + script(relay(timeline())), 'natgeo');
    assert.equal(result?.profile.isPrivate, privacy);
    assert.equal(result?.posts.length, 0);
});
test('parser depth remains bounded', () => {
    let value: unknown = profile();
    for (let i = 0; i < 40; i++) value = { child: value };
    assert.equal(parseInstagramPayload(value, 'natgeo'), null);
});
test('deep complete HTML supplies post analytics in one request, without metadata endpoint', async () => {
    let calls = 0;
    const result = await collectProfile('natgeo', async request => {
        calls++;
        assert.equal(request.url, 'https://www.instagram.com/natgeo/');
        return { statusCode: 200, headers: { 'content-type': 'text/html' },
            body: script(relay(profile())) + script(relay(timeline())) };
    }, async () => undefined, () => false, true);
    assert.equal(result.status, 'OK');
    assert.equal(calls, 1);
    assert.equal(result.result?.posts.length, 1);
});
