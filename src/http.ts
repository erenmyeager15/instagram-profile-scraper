import { gotScraping } from 'got-scraping';
import type { IncomingHttpHeaders } from 'node:http';
import type { HttpRequest, HttpResponse } from './collector.js';

export const MAX_RESPONSE_BYTES = 3_000_000;
export async function requestProfile(options: HttpRequest, remainingMs: number): Promise<HttpResponse> {
    if (remainingMs <= 0) throw new Error('Run deadline reached.');
    const stream = gotScraping.stream({ url: options.url, proxyUrl: options.proxyUrl, headers: options.headers, sessionToken: options.sessionToken,
        timeout: { request: Math.min(options.timeoutMs, remainingMs) }, retry: { limit: 0 },
        throwHttpErrors: false, followRedirect: false });
    let statusCode = 0;
    let headers: IncomingHttpHeaders = {};
    let bodyDiscarded = false;
    stream.once('response', response => {
        statusCode = response.statusCode; headers = response.headers;
        // Error/redirect bodies cannot produce a profile. Stop reading them immediately.
        if (statusCode !== 200) { bodyDiscarded = true; stream.destroy(); }
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
        for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_RESPONSE_BYTES) {
                stream.destroy();
                throw new Error('Profile response exceeded safety size.');
            }
            chunks.push(buffer);
        }
    } catch (error) { if (!bodyDiscarded) throw error; }
    return { statusCode, body: bodyDiscarded ? '' : Buffer.concat(chunks).toString('utf8'), bodyDiscarded, headers: {
        'set-cookie': headers['set-cookie'], location: headers.location, 'content-type': headers['content-type'],
    } };
}
