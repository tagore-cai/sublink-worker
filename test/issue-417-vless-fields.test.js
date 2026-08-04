import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { parseVless } from '../src/parsers/protocols/vlessParser.js';
import { parseTuic } from '../src/parsers/protocols/tuicParser.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';

const createTestApp = () => {
    const runtime = {
        kv: new MemoryKVAdapter(),
        assetFetcher: null,
        logger: console,
        config: { configTtlSeconds: 60, shortLinkTtlSeconds: null }
    };
    return createApp(runtime);
};

describe('issue-417 VLESS fields', () => {
    it('parses encryption, alpn, packet_encoding and xhttp mode', () => {
        const node = parseVless('vless://00000000-0000-4000-8000-000000000001@203.0.113.10:443?encryption=mlkem768x25519plus.native.0rtt&flow=xtls-rprx-vision&security=reality&sni=example.com&type=xhttp&path=test-xh&mode=auto&alpn=h3,http/1.1&packet_encoding=xudp#test-node');
        expect(node.encryption).toBe('mlkem768x25519plus.native.0rtt');
        expect(node.alpn).toEqual(['h3', 'http/1.1']);
        expect(node.packet_encoding).toBe('xudp');
        expect(node.transport).toMatchObject({ type: 'xhttp', path: 'test-xh', mode: 'auto' });
    });

    it('parses insecure=0 as false and insecure=1 as true', () => {
        expect(parseVless('vless://u@h.com:443?security=tls&insecure=0#a').tls.insecure).toBe(false);
        expect(parseVless('vless://u@h.com:443?security=tls&insecure=1#b').tls.insecure).toBe(true);
        expect(parseVless('vless://u@h.com:443?security=tls#c').tls.insecure).toBe(false);
    });

    it('defaults TUIC insecure to false unless explicitly enabled', () => {
        expect(parseTuic('tuic://uuid:pwd@h.com:443?sni=h.com#c').tls.insecure).toBe(false);
        expect(parseTuic('tuic://uuid:pwd@h.com:443?sni=h.com&insecure=1#d').tls.insecure).toBe(true);
    });

    it('emits xhttp-opts, encryption and keeps alpn-distinct nodes in Clash', async () => {
        const input = [
            'vless://00000000-0000-4000-8000-000000000001@203.0.113.10:443?security=reality&sni=example.com&type=xhttp&path=test-xh&mode=auto&encryption=mlkem768x25519plus.native.0rtt&insecure=0#node-a',
            'vless://00000000-0000-4000-8000-000000000001@203.0.113.10:443?security=reality&sni=example.com&type=xhttp&path=test-xh&mode=auto&alpn=h3#node-b',
            'vless://00000000-0000-4000-8000-000000000001@203.0.113.10:443?security=reality&sni=example.com&type=xhttp&path=test-xh&mode=auto&alpn=http/1.1#node-c'
        ].join('\n');
        const builder = new ClashConfigBuilder(input, 'all', [], null, 'zh-CN', 'test-agent', false);
        const text = await builder.build();
        const built = yaml.load(text);
        const vless = (built.proxies || []).filter(p => p.type === 'vless');

        expect(vless).toHaveLength(3);
        const byName = Object.fromEntries(vless.map(p => [p.name, p]));
        expect(byName['node-a']['xhttp-opts']).toMatchObject({ path: 'test-xh', mode: 'auto' });
        expect(byName['node-a'].encryption).toBe('mlkem768x25519plus.native.0rtt');
        expect(byName['node-a']['skip-cert-verify']).toBe(false);
        expect(byName['node-b'].alpn).toEqual(['h3']);
        expect(byName['node-c'].alpn).toEqual(['http/1.1']);
    });

    it('GET /clash keeps both alpn-distinct nodes', async () => {
        const app = createTestApp();
        const input = [
            'vless://00000000-0000-4000-8000-000000000001@203.0.113.10:443?security=reality&sni=example.com&type=xhttp&path=test-xh&mode=auto&alpn=h3#node-b',
            'vless://00000000-0000-4000-8000-000000000001@203.0.113.10:443?security=reality&sni=example.com&type=xhttp&path=test-xh&mode=auto&alpn=http/1.1#node-c'
        ].join('\n');
        const res = await app.request(`http://localhost/clash?config=${encodeURIComponent(input)}`);
        expect(res.status).toBe(200);
        const built = yaml.load(await res.text());
        const names = (built.proxies || []).map(p => p.name);
        expect(names).toContain('node-b');
        expect(names).toContain('node-c');
    });
});

describe('issue-417 short link returns config directly', () => {
    it('GET /c/:code returns the final Clash config with HTTP 200', async () => {
        const app = createTestApp();
        const input = 'vless://00000000-0000-4000-8000-000000000001@203.0.113.10:443?security=reality&sni=example.com&type=xhttp&path=test-xh&mode=auto#node-a';
        const qs = 'config=' + encodeURIComponent(input) + '&selectedRules=' + JSON.stringify(['balanced']);
        const shortRes = await app.request('http://localhost/shorten-v2?url=' + encodeURIComponent('http://localhost/clash?' + qs));
        expect(shortRes.status).toBe(200);
        const code = (await shortRes.text()).trim();
        expect(code).toBeTruthy();

        const res = await app.request('http://localhost/c/' + code);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/yaml');
        const built = yaml.load(await res.text());
        expect((built.proxies || []).map(p => p.name)).toContain('node-a');
    });
});
