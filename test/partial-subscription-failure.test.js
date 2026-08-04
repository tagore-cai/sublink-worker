import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { fetchSubscriptionWithFormat } from '../src/parsers/subscription/httpSubscriptionFetcher.js';

const okSub = (url, text) => ({
    url,
    ok: true,
    status: 200,
    text: async () => text,
    headers: { get: () => null }
});

function mockFetchImplement(impl) {
    vi.stubGlobal('fetch', vi.fn(impl));
}

// A fetch that never settles on its own but rejects when the caller aborts.
const hangUntilAborted = (url, init) =>
    new Promise((resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

describe('partial subscription failure handling (#417-followup)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('skips a failing/hung subscription and still builds config from the good one', async () => {
        const goodLines = [
            'vless://00000000-0000-4000-8000-000000000001@hk.example.com:443?security=tls&sni=h.com#HK-OK',
            'ss://YWVzLTEyOC1nY206cGFzcw@sg.example.com:443#SG-OK'
        ].join('\n');
        // First source hangs (only rejects when aborted); second resolves normally.
        mockFetchImplement(async (url, init) => {
            if (url.includes('slow')) {
                return hangUntilAborted(url, init);
            }
            return okSub(url, goodLines);
        });

        const input = 'https://example.com/slow-sub\nhttps://example.com/good-sub';
        const builder = new ClashConfigBuilder(input, 'minimal', [], null, 'zh-CN', 'test-agent');
        const text = await builder.build();
        const built = yaml.load(text);
        const names = (built.proxies || []).map(p => p.name);
        expect(names).toContain('HK-OK');
        expect(names).toContain('SG-OK');
    }, 15000);

    it('aborts a slow fetch before the timeout instead of hanging forever', async () => {
        mockFetchImplement(hangUntilAborted);

        const startedAt = Date.now();
        const result = await fetchSubscriptionWithFormat('https://example.com/slow-sub', 'test-agent', 200);
        const elapsed = Date.now() - startedAt;

        expect(result).toBeNull();  // timed out -> null
        expect(elapsed).toBeGreaterThanOrEqual(150);
        expect(elapsed).toBeLessThan(5000);  // well under any platform cap
    });
});
