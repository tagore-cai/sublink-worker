import { parseCountryFromNodeName } from '../utils.js';

const TYPE_ALIASES = {
    ss: 'shadowsocks',
    shadowsocks: 'shadowsocks',
    vmess: 'vmess',
    vless: 'vless',
    trojan: 'trojan',
    tuic: 'tuic',
    hy2: 'hysteria2',
    hysteria: 'hysteria2',
    hysteria2: 'hysteria2',
    anytls: 'anytls'
};

export function normalizeType(value) {
    if (typeof value !== 'string') return value;
    return TYPE_ALIASES[value.trim().toLowerCase()] || value.trim().toLowerCase();
}

function parseQueryString(raw) {
    if (typeof raw !== 'string' || !raw) return new URLSearchParams();
    // Accept a full URL (e.g. "https://host/xray?include=HK") or a bare query string.
    const questionIndex = raw.indexOf('?');
    const queryPart = questionIndex !== -1 ? raw.slice(questionIndex + 1) : raw;
    try {
        return new URLSearchParams(queryPart);
    } catch {
        return new URLSearchParams();
    }
}

function splitList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.flatMap(item => String(item).split(',')).map(s => s.trim()).filter(Boolean);
    }
    return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

function normalizeCountry(code) {
    return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

export function parseProxyFilter(query) {
    if (!query) return null;
    const params = typeof query === 'string' ? parseQueryString(query) : query;
    const has = (name) => {
        const value = params.get(name);
        return value !== null && value !== undefined && value.trim() !== '';
    };

    const include = splitList(params.get('include'));
    const exclude = splitList(params.get('exclude'));
    const includeCountry = splitList(params.get('include_country')).map(normalizeCountry).filter(Boolean);
    const excludeCountry = splitList(params.get('exclude_country')).map(normalizeCountry).filter(Boolean);
    const includeType = splitList(params.get('include_type')).map(normalizeType).filter(Boolean);
    const excludeType = splitList(params.get('exclude_type')).map(normalizeType).filter(Boolean);

    const active = has('include') || has('exclude') || has('include_country') || has('exclude_country') || has('include_type') || has('exclude_type');
    if (!active) return null;

    return { include, exclude, includeCountry, excludeCountry, includeType, excludeType };
}

function namePattern(keyword) {
    // Support /regex/ syntax for exact matching; fall back to substring matching.
    if (keyword.length > 2 && keyword.startsWith('/') && keyword.endsWith('/')) {
        try {
            return { regex: new RegExp(keyword.slice(1, -1), 'i') };
        } catch {
            return { substring: keyword.toLowerCase() };
        }
    }
    return { substring: keyword.toLowerCase() };
}

function matchName(name, keyword) {
    if (typeof name !== 'string') return false;
    const pattern = namePattern(keyword);
    if (pattern.regex) {
        pattern.regex.lastIndex = 0;
        return pattern.regex.test(name);
    }
    return name.toLowerCase().includes(pattern.substring);
}

function matchesAnyName(name, keywords) {
    return keywords.some(keyword => matchName(name, keyword));
}

function countryOf(proxy) {
    const name = getName(proxy);
    if (typeof name !== 'string' || !name) return undefined;
    const info = parseCountryFromNodeName(name);
    return info?.code;
}

function getName(proxy) {
    if (proxy == null) return undefined;
    return proxy.tag ?? proxy.name ?? undefined;
}

/**
 * Filter a list of parsed proxy items by name/country/type.
 *
 * Semantics:
 * - Exclude always wins: any match in any exclude category drops the node.
 * - Include acts as a whitelist per category: if a category's include list is
 *   non-empty, the node must match at least one entry in that category.
 */
export function filterProxies(proxies, filter) {
    if (!filter || !Array.isArray(proxies)) return proxies;
    const { include = [], exclude = [], includeCountry = [], excludeCountry = [], includeType = [], excludeType = [] } = filter;
    if ([include, exclude, includeCountry, excludeCountry, includeType, excludeType].every(arr => arr.length === 0)) {
        return proxies;
    }

    return proxies.filter(proxy => {
        const name = getName(proxy);
        const country = countryOf(proxy);
        const type = normalizeType(proxy?.type);
        const normalizedIncludeType = includeType.map(normalizeType).filter(Boolean);
        const normalizedExcludeType = excludeType.map(normalizeType).filter(Boolean);

        if (matchesAnyName(name, exclude)) return false;
        if (excludeCountry.length > 0 && country && excludeCountry.includes(country)) return false;
        if (normalizedExcludeType.length > 0 && type && normalizedExcludeType.includes(type)) return false;

        if (include.length > 0 && !matchesAnyName(name, include)) return false;
        if (includeCountry.length > 0 && !(country && includeCountry.includes(country))) return false;
        if (normalizedIncludeType.length > 0 && !(type && normalizedIncludeType.includes(type))) return false;

        return true;
    });
}

function extractUriInfo(line) {
    const trimmed = typeof line === 'string' ? line.trim() : '';
    if (!trimmed) return null;
    const scheme = trimmed.split('://')[0] || '';
    const hashIndex = trimmed.lastIndexOf('#');
    let name = '';
    if (hashIndex !== -1) {
        try {
            name = decodeURIComponent(trimmed.slice(hashIndex + 1));
        } catch {
            name = trimmed.slice(hashIndex + 1);
        }
    }
    return { tag: name, type: normalizeType(scheme) };
}

/**
 * Filter raw subscription URI lines (used by the /xray passthrough endpoint).
 * Builds a pseudo-proxy from scheme + fragment name so the same rules apply.
 */
export function filterUriLines(lines, filter) {
    if (!filter || !Array.isArray(lines)) return lines;
    const keep = new Set();
    lines.forEach((line, index) => {
        const proxy = extractUriInfo(line);
        if (proxy && filterProxies([proxy], filter).length > 0) {
            keep.add(index);
        }
    });
    return lines.filter((_, index) => keep.has(index));
}
