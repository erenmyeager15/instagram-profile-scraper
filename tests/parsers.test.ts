import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeInstagramResults, parseCount, parseInstagramHtml, parseInstagramPayload } from '../src/parsers.js';

test('parseCount handles compact public metrics', () => {
    assert.equal(parseCount('2.5M'), 2_500_000);
    assert.equal(parseCount('12,345'), 12_345);
});

test('parseInstagramPayload maps profile and recent posts', () => {
    const result = parseInstagramPayload({ data: { user: {
        username: 'natgeo', full_name: 'National Geographic', biography: 'Planet stories',
        edge_followed_by: { count: 100 }, edge_follow: { count: 2 }, is_verified: true,
        edge_owner_to_timeline_media: { count: 1, edges: [{ node: {
            id: '1', shortcode: 'ABC', __typename: 'GraphImage', display_url: 'https://image.example/1.jpg',
            taken_at_timestamp: 1_700_000_000, edge_media_to_caption: { edges: [{ node: { text: '#earth @natgeo' } }] },
            edge_media_preview_like: { count: 10 }, edge_media_to_comment: { count: 3 },
        } }] },
    } } }, 'natgeo');
    assert.equal(result?.profile.followers, 100);
    assert.equal(result?.posts[0].postUrl, 'https://www.instagram.com/p/ABC/');
    assert.deepEqual(result?.posts[0].hashtags, ['#earth']);
});

test('parseInstagramHtml rejects unrelated or empty pages', () => {
    assert.equal(parseInstagramHtml('<html><title>Challenge</title></html>', 'natgeo'), null);
});

test('mergeInstagramResults fills incomplete API metrics from page metadata', () => {
    const primary = parseInstagramPayload({ data: { user: {
        username: 'demo', full_name: 'Demo', edge_followed_by: { count: 50 },
        edge_owner_to_timeline_media: { count: 0, edges: [] },
    } } }, 'demo');
    const fallback = parseInstagramHtml(
        '<meta property="og:title" content="Demo (@demo)"><meta property="og:description" content="50 Followers, 2 Following, 12 Posts">',
        'demo',
    );
    assert.equal(mergeInstagramResults(primary, fallback)?.profile.postsCount, 12);
});
