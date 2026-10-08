import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import { gzipSync } from 'node:zlib';
import { requestProfile, MAX_RESPONSE_BYTES } from '../src/http.js';
import { collectProfile } from '../src/collector.js';

async function localServer(handler: RequestListener, run: (url: string) => Promise<void>) {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try { await run(`http://127.0.0.1:${address.port}/`); }
    finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}
const read = (url: string, remaining = 3_000, sessionToken?: object) => requestProfile({ url, headers: {}, timeoutMs: 3_000, sessionToken }, remaining);

test('real HTTP stream returns UTF-8 body, status and same-session cookies', async () => {
    await localServer((_req, res) => { res.setHeader('Set-Cookie', ['csrftoken=demo; Path=/']); res.end('Brand ✨'); }, async url => {
        const result = await read(url); assert.equal(result.statusCode, 200); assert.equal(result.body, 'Brand ✨');
        assert.deepEqual(result.headers['set-cookie'], ['csrftoken=demo; Path=/']);
    });
});
test('real HTTP stream returns blocked status without an automatic retry', async () => {
    let calls = 0;
    await localServer((_req, res) => { calls++; res.writeHead(429); res.end('Slow down'); }, async url => {
        const result = await read(url); assert.equal(result.statusCode, 429); assert.equal(result.body, '');
        assert.equal(result.bodyDiscarded, true); assert.equal(calls, 1);
    });
});
test('real HTTP stream does not follow a redirect', async () => {
    let calls = 0;
    await localServer((_req, res) => { calls++; res.writeHead(302, { Location: '/other' }); res.end('Redirect'); }, async url => {
        assert.equal((await read(url)).statusCode, 302); assert.equal(calls, 1);
    });
});
test('real HTTP stream aborts oversized responses before parsing', async () => {
    await localServer((_req, res) => res.end('x'.repeat(MAX_RESPONSE_BYTES + 1)), async url => {
        await assert.rejects(read(url), /safety size/);
    });
});
test('real HTTP stream caps decompressed size, not just compressed transfer size', async () => {
    const compressed = gzipSync('x'.repeat(MAX_RESPONSE_BYTES + 1));
    await localServer((_req, res) => { res.setHeader('Content-Encoding', 'gzip'); res.end(compressed); }, async url => {
        await assert.rejects(read(url), /safety size/);
    });
});
test('real HTTP stream respects remaining run time and does not retry timeout', async () => {
    let calls = 0;
    await localServer(() => { calls++; }, async url => {
        const started = Date.now(); await assert.rejects(read(url, 100), /Timeout/);
        assert.equal(calls, 1); assert.ok(Date.now() - started < 2_000);
    });
});
test('expired run does not open a connection', async () => {
    let calls = 0;
    await localServer((_req, res) => { calls++; res.end(); }, async url => {
        await assert.rejects(read(url, 0), /deadline/); assert.equal(calls, 0);
    });
});
test('same HTTP session keeps generated browser identity across requests', async () => {
    const agents: string[] = [];
    await localServer((req, res) => { agents.push(req.headers['user-agent'] ?? ''); res.end('ok'); }, async url => {
        const token = {};
        await read(url, 3_000, token); await read(url, 3_000, token);
        assert.ok(agents[0]); assert.equal(agents[0], agents[1]);
    });
});
test('real HTTP stops a never-ending blocked body immediately after headers', async () => {
    let closed = false;
    await localServer((_req, res) => {
        res.on('close', () => { closed = true; });
        res.writeHead(403, { 'Content-Type': 'text/html', 'Set-Cookie': 'mid=blocked; Path=/' });
        res.flushHeaders();
        // Deliberately never finish the body: the reader must not wait for the request timeout.
    }, async url => {
        const started = Date.now(); const result = await read(url);
        assert.equal(result.statusCode, 403); assert.equal(result.body, ''); assert.equal(result.bodyDiscarded, true);
        assert.deepEqual(result.headers['set-cookie'], ['mid=blocked; Path=/']);
        assert.ok(Date.now() - started < 2_000);
        await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(closed, true);
    });
});
test('real HTTP ignores a huge error body instead of failing the success-body parser limit', async () => {
    await localServer((_req, res) => { res.writeHead(503); res.end('x'.repeat(MAX_RESPONSE_BYTES + 1)); }, async url => {
        const result = await read(url); assert.equal(result.statusCode, 503); assert.equal(result.body, ''); assert.equal(result.bodyDiscarded, true);
    });
});
test('collector and real HTTP safely follow a canonical profile with session cookies intact', async () => {
    const seen: { path: string; agent: string | undefined; cookie: string | undefined; csrf: string | string[] | undefined }[] = [];
    const user = { username: 'demo', id: '1', is_private: false, biography: '', external_url: '',
        edge_followed_by: { count: 100 }, edge_follow: { count: 10 }, edge_owner_to_timeline_media: { count: 2, edges: [] } };
    await localServer((req, res) => {
        seen.push({ path: req.url!, agent: req.headers['user-agent'], cookie: req.headers.cookie, csrf: req.headers['x-csrftoken'] });
        if (req.url === '/demo/') {
            res.writeHead(301, { Location: '/Demo/', 'Set-Cookie': ['mid=first; Path=/; Secure', 'csrftoken=old; Path=/; Secure'] });
            res.flushHeaders(); // No body completion: the transport must release this connection itself.
        } else if (req.url === '/Demo/') {
            res.setHeader('Set-Cookie', 'csrftoken=new; Path=/; Secure');
            res.end(`<script type="application/json">${JSON.stringify({ data: { user: { ...user, edge_follow: undefined } } })}</script>`);
        } else if (req.url === '/api/v1/users/web_profile_info/?username=demo') res.end(JSON.stringify({ data: { user } }));
        else { res.writeHead(404); res.end(); }
    }, async url => {
        // Route every request to the loopback fixture; no Instagram/proxy connection is made.
        const lookup = await collectProfile('demo', options => {
            const source = new URL(options.url);
            return requestProfile({ ...options, url: `${url.slice(0, -1)}${source.pathname}${source.search}` }, 3_000);
        }, async () => undefined, () => false);
        assert.equal(lookup.status, 'OK'); assert.equal(lookup.requests, 3); assert.equal(lookup.result?.profile.following, 10);
        assert.deepEqual(seen.map(row => row.path), ['/demo/', '/Demo/', '/api/v1/users/web_profile_info/?username=demo']);
        assert.ok(seen[0].agent); assert.ok(seen.every(row => row.agent === seen[0].agent));
        assert.equal(seen[1].cookie, 'mid=first; csrftoken=old'); assert.equal(seen[2].cookie, 'mid=first; csrftoken=new');
        assert.equal(seen[2].csrf, 'new'); assert.equal(lookup.traces[0].bodyDiscarded, true);
    });
});
test('collector and real HTTP recover once from a refused page without leaking its cookies', async () => {
    const cookies: (string | undefined)[] = [];
    const sessions: (object | undefined)[] = [];
    const user = { username: 'demo', is_private: false, biography: '', external_url: '',
        edge_followed_by: { count: 100 }, edge_follow: { count: 10 }, edge_owner_to_timeline_media: { count: 2, edges: [] } };
    await localServer((req, res) => {
        cookies.push(req.headers.cookie);
        if (cookies.length === 1) { res.writeHead(403, { 'Set-Cookie': 'mid=refused; Path=/; Secure' }); res.flushHeaders(); }
        else res.end(`<script type="application/json">${JSON.stringify({ data: { user } })}</script>`);
    }, async url => {
        const lookup = await collectProfile('demo', options => {
            sessions.push(options.sessionToken);
            return requestProfile({ ...options, url }, 3_000);
        }, async () => undefined, () => false);
        assert.equal(lookup.status, 'OK'); assert.equal(lookup.requests, 2); assert.equal(lookup.attempts, 2);
        assert.deepEqual(cookies, [undefined, undefined]); assert.notEqual(sessions[0], sessions[1]);
        assert.deepEqual(lookup.traces.map(row => row.stage), ['profile-page', 'profile-page']);
    });
});
