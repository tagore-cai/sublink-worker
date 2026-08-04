import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { filterProxies, filterUriLines, parseProxyFilter, normalizeType } from '../src/utils/proxyFilter.js';

const createTestApp = () => {
    const runtime = {
        kv: new MemoryKVAdapter(),
        assetFetcher: null,
        logger: console,
        config: { configTtlSeconds: 60, shortLinkTtlSeconds: null }
    };
    return createApp(runtime);
};

const SAMPLE_INPUT = `
ss://YWVzLTEyOC1nY206dGVzdA@example.com:443#HK-Node-1
ss://YWVzLTEyOC1nY206dGVzdA@example.com:445#US-Node-1
trojan://password@example.com:443?sni=example.com#HK-Node-2
vmess://ewogICJ2IjogIjIiLAogICJwcyI6ICJqcC5ub2RlLmNvbSIsCiAgImFkZCI6ICJqcC5ub2RlLmNvbSIsCiAgInBvcnQiOiA0NDMsCiAgImlkIjogImRhOGNhZDE2LWIxMzUtNDJmZS1hM2I2LTc1MmRhYWNhOTBiMCIsCiAgImFpZCI6IDAsCiAgIm5ldCI6ICJ3cyIsCiAgInR5cGUiOiAibm9uZSIsCiAgImhvc3QiOiAianAubm9kZS5jb20iLAogICJwYXRoIjogIi92bWVzcyIsCiAgInRscyI6ICJ0bHMiCn0=#JP-Node-1
`;

describe('proxyFilter utils', () => {
    it('parses filter query params from a full URL', () => {
        const filter = parseProxyFilter('https://host/clash?include=HK,KR&exclude=IPLC&include_country=JP&include_type=vmess,trojan&exclude_type=ss');
        expect(filter).toEqual({
            include: ['HK', 'KR'],
            exclude: ['IPLC'],
            includeCountry: ['JP'],
            excludeCountry: [],
            includeType: ['vmess', 'trojan'],
            excludeType: ['shadowsocks']
        });
    });

    it('returns null when no filter params present', () => {
        expect(parseProxyFilter('https://host/clash?config=abc')).toBeNull();
        expect(parseProxyFilter('')).toBeNull();
        expect(parseProxyFilter(null)).toBeNull();
    });

    it('normalizes protocol aliases', () => {
        expect(normalizeType('ss')).toBe('shadowsocks');
        expect(normalizeType('hy2')).toBe('hysteria2');
        expect(normalizeType('hysteria')).toBe('hysteria2');
        expect(normalizeType('VMESS')).toBe('vmess');
        expect(normalizeType('anytls')).toBe('anytls');
    });

    it('filters by name include/exclude', () => {
        const proxies = [
            { tag: 'HK-Node-1', type: 'shadowsocks' },
            { tag: 'US-Node-1', type: 'shadowsocks' },
            { tag: 'IPLC HK-01', type: 'trojan' }
        ];
        expect(filterProxies(proxies, { include: ['HK'] }).map(p => p.tag)).toEqual(['HK-Node-1', 'IPLC HK-01']);
        expect(filterProxies(proxies, { exclude: ['IPLC'] }).map(p => p.tag)).toEqual(['HK-Node-1', 'US-Node-1']);
    });

    it('filters by country include/exclude', () => {
        const proxies = [
            { tag: '香港节点1', type: 'shadowsocks' },
            { tag: 'US-Node-1', type: 'shadowsocks' },
            { tag: '日本高速', type: 'vmess' }
        ];
        expect(filterProxies(proxies, { includeCountry: ['HK', 'JP'] }).map(p => p.tag)).toEqual(['香港节点1', '日本高速']);
        expect(filterProxies(proxies, { excludeCountry: ['US'] }).map(p => p.tag)).toEqual(['香港节点1', '日本高速']);
    });

    it('filters by protocol type include/exclude', () => {
        const proxies = [
            { tag: 'A', type: 'shadowsocks' },
            { tag: 'B', type: 'trojan' },
            { tag: 'C', type: 'vmess' }
        ];
        expect(filterProxies(proxies, { includeType: ['ss', 'vmess'] }).map(p => p.tag)).toEqual(['A', 'C']);
        expect(filterProxies(proxies, { excludeType: ['trojan'] }).map(p => p.tag)).toEqual(['A', 'C']);
    });

    it('supports /regex/ name matching', () => {
        const proxies = [
            { tag: 'HK-01 Premium', type: 'vmess' },
            { tag: 'HK-02', type: 'vmess' },
            { tag: 'US-01', type: 'vmess' }
        ];
        expect(filterProxies(proxies, { include: ['/^HK-\\d+$/'] }).map(p => p.tag)).toEqual(['HK-02']);
    });

    it('exclude wins over include', () => {
        const proxies = [
            { tag: 'HK-Node-1', type: 'shadowsocks' },
            { tag: 'HK-Node-2', type: 'trojan' }
        ];
        expect(filterProxies(proxies, { include: ['HK'], excludeType: ['trojan'] }).map(p => p.tag)).toEqual(['HK-Node-1']);
    });

    it('returns the list unchanged when no filter rules are active', () => {
        const proxies = [{ tag: 'A', type: 'shadowsocks' }];
        expect(filterProxies(proxies, null)).toBe(proxies);
        expect(filterProxies(proxies, { include: [], exclude: [] })).toEqual(proxies);
    });

    it('filters raw URI lines by name/country for xray', () => {
        const lines = [
            'ss://base64#HK-Node-1',
            'trojan://x@y.com:443#US-Node-1',
            'vmess://ewo=#日本高速'
        ];
        expect(filterUriLines(lines, { includeCountry: ['HK', 'JP'] })).toEqual(['ss://base64#HK-Node-1', 'vmess://ewo=#日本高速']);
        expect(filterUriLines(lines, { excludeType: ['shadowsocks'] })).toEqual(['trojan://x@y.com:443#US-Node-1', 'vmess://ewo=#日本高速']);
    });
});

describe('proxy filter endpoints', () => {
    it('GET /clash filters proxies by name include', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/clash?config=${encodeURIComponent(SAMPLE_INPUT)}&include=HK`);
        expect(res.status).toBe(200);
        const built = yaml.load(await res.text());
        const names = (built.proxies || []).map(p => p.name);
        expect(names).toContain('HK-Node-1');
        expect(names).toContain('HK-Node-2');
        expect(names).not.toContain('US-Node-1');
        expect(names).not.toContain('JP-Node-1');
    });

    it('GET /clash filters proxies by country', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/clash?config=${encodeURIComponent(SAMPLE_INPUT)}&include_country=JP`);
        expect(res.status).toBe(200);
        const built = yaml.load(await res.text());
        const names = (built.proxies || []).map(p => p.name);
        expect(names).toEqual(['JP-Node-1']);
    });

    it('GET /clash filters proxies by protocol type', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/clash?config=${encodeURIComponent(SAMPLE_INPUT)}&exclude_type=shadowsocks`);
        expect(res.status).toBe(200);
        const built = yaml.load(await res.text());
        const names = (built.proxies || []).map(p => p.name);
        expect(names).toContain('HK-Node-2');
        expect(names).toContain('JP-Node-1');
        expect(names).not.toContain('HK-Node-1');
        expect(names).not.toContain('US-Node-1');
    });

    it('GET /singbox filters proxies by name exclude', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/singbox?config=${encodeURIComponent(SAMPLE_INPUT)}&exclude=US`);
        expect(res.status).toBe(200);
        const json = await res.json();
        const tags = (json.outbounds || []).filter(o => o.server).map(o => o.tag);
        expect(tags).toContain('HK-Node-1');
        expect(tags).not.toContain('US-Node-1');
    });

    it('GET /surge filters proxies by name include', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/surge?config=${encodeURIComponent(SAMPLE_INPUT)}&include=JP`);
        expect(res.status).toBe(200);
        const text = await res.text();
        const proxySection = text.split('[Proxy]')[1]?.split('[Proxy Group]')[0] || '';
        expect(proxySection).toContain('JP-Node-1');
        expect(proxySection).not.toContain('HK-Node-1');
        expect(proxySection).not.toContain('US-Node-1');
    });

    it('GET /xray filters base64 output by country', async () => {
        const app = createTestApp();
        const res = await app.request(`http://localhost/xray?config=${encodeURIComponent(SAMPLE_INPUT)}&include_country=HK`);
        expect(res.status).toBe(200);
        const text = await res.text();
        // Decode the base64 response
        const decoded = Buffer.from(text, 'base64').toString('utf-8');
        expect(decoded).toContain('HK-Node-1');
        expect(decoded).toContain('HK-Node-2');
        expect(decoded).not.toContain('US-Node-1');
        expect(decoded).not.toContain('JP-Node-1');
    });
});
