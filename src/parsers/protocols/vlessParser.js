import { parseServerInfo, parseUrlParams, createTlsConfig, createTransportConfig, parseBool, parseArray } from '../../utils.js';

export function parseVless(url) {
    const { addressPart, params, name } = parseUrlParams(url);
    const [uuid, serverInfo] = addressPart.split('@');
    const { host, port } = parseServerInfo(serverInfo);

    const tls = createTlsConfig(params);
    if (tls.reality) {
        tls.utls = {
            enabled: true,
            fingerprint: 'chrome'
        };
    }
    const transport = params.type !== 'tcp' ? createTransportConfig(params) : undefined;

    // `udp` is a Clash-only flag; ClashConfigBuilder reads it, SingboxConfigBuilder strips it.
    const udp = params.udp !== undefined ? parseBool(params.udp) : undefined;

    return {
        type: 'vless',
        tag: name,
        server: host,
        server_port: port,
        uuid: decodeURIComponent(uuid),
        tcp_fast_open: false,
        tls,
        transport,
        flow: params.flow ?? undefined,
        // Preserve post-quantum encryption and fields that Clash distinguishes
        // nodes by, otherwise identical nodes get deduped away (issue #417).
        ...(params.encryption && { encryption: params.encryption }),
        ...(params.alpn && { alpn: parseArray(params.alpn) }),
        ...(params.packet_encoding && { packet_encoding: params.packet_encoding }),
        ...(udp !== undefined ? { udp } : {})
    };
}
