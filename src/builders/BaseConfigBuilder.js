import { ProxyParser } from '../parsers/index.js';
import { createStableProviderName, deepCopy, tryDecodeSubscriptionLines, decodeBase64 } from '../utils.js';
import { filterProxies } from '../utils/proxyFilter.js';
import { createTranslator } from '../i18n/index.js';
import { generateRules, getOutbounds, PREDEFINED_RULE_SETS } from '../config/index.js';

export class BaseConfigBuilder {
    constructor(inputString, baseConfig, lang, userAgent, groupByCountry = false, includeAutoSelect = true, proxyFilter = null) {
        this.inputString = inputString;
        this.config = deepCopy(baseConfig);
        this.customRules = [];
        this.selectedRules = [];
        this.t = createTranslator(lang);
        this.userAgent = userAgent;
        this.appliedOverrideKeys = new Set();
        this.groupByCountry = groupByCountry;
        this.includeAutoSelect = includeAutoSelect;
        this.proxyFilter = proxyFilter;
        this.providerUrls = [];  // URLs to use as providers (auto-sync)
        this.providerNodeNames = [];  // node names from provider subscriptions, for country enumeration only
        this.autoProviderDescriptors = undefined;
        this.subscriptionUserinfo = undefined;
    }

    async build() {
        const customItems = await this.parseCustomItems();
        this.addCustomItems(customItems);
        this.addSelectors();
        return this.formatConfig();
    }

    async parseCustomItems() {
        const input = this.inputString || '';
        const parsedItems = [];

        // Import the content parser for direct input parsing
        const { parseSubscriptionContent } = await import('../parsers/subscription/subscriptionContentParser.js');
        const { fetchSubscriptionWithFormat } = await import('../parsers/subscription/httpSubscriptionFetcher.js');

        // Try to parse the entire input as a config format (Sing-Box JSON or Clash YAML)
        const directResult = parseSubscriptionContent(input);
        if (directResult && typeof directResult === 'object' && directResult.type) {
            // It's a parsed config (singboxConfig or yamlConfig)
            if (directResult.config) {
                this.applyConfigOverrides(directResult.config);
            }
            if (Array.isArray(directResult.proxies)) {
                for (const proxy of directResult.proxies) {
                    if (proxy && proxy.tag) {
                        parsedItems.push(proxy);
                    }
                }
                if (parsedItems.length > 0) return parsedItems;
            }
        }

        // If direct parsing didn't work, check for Base64 encoded content
        const isBase64Like = /^[A-Za-z0-9+/=\r\n]+$/.test(input) && input.replace(/[\r\n]/g, '').length % 4 === 0;
        if (isBase64Like) {
            try {
                const sanitized = input.replace(/\s+/g, '');
                const decodedWhole = decodeBase64(sanitized);
                if (typeof decodedWhole === 'string') {
                    const decodedResult = parseSubscriptionContent(decodedWhole);
                    if (decodedResult && typeof decodedResult === 'object' && decodedResult.type) {
                        if (decodedResult.config) {
                            this.applyConfigOverrides(decodedResult.config);
                        }
                        if (Array.isArray(decodedResult.proxies)) {
                            for (const proxy of decodedResult.proxies) {
                                if (proxy && proxy.tag) {
                                    parsedItems.push(proxy);
                                }
                            }
                            if (parsedItems.length > 0) return parsedItems;
                        }
                    }
                }
            } catch (_) { }
        }

        // Otherwise, line-by-line processing (URLs, subscription content, remote lists, etc.)
        const urls = input.split('\n').filter(url => url.trim() !== '');
        const expandedUrls = [];
        for (const url of urls) {
            let processedUrls = tryDecodeSubscriptionLines(url);
            if (!Array.isArray(processedUrls)) {
                processedUrls = [processedUrls];
            }
            for (const processedUrl of processedUrls) {
                const trimmedUrl = typeof processedUrl === 'string' ? processedUrl.trim() : '';
                if (!trimmedUrl) continue;
                const isHttp = trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://');
                expandedUrls.push({ trimmedUrl, isHttp });
            }
        }

        // Fetch all remote subscriptions in parallel so one slow/hung source does
        // not stall the rest (Cloudflare Workers caps total request time at 30s).
        const fetchPromises = expandedUrls
            .filter(entry => entry.isHttp)
            .map(entry => fetchSubscriptionWithFormat(entry.trimmedUrl, this.userAgent)
                .then(result => ({ url: entry.trimmedUrl, result }))
                .catch(() => ({ url: entry.trimmedUrl, result: null })));
        const fetchResults = new Map();
        (await Promise.all(fetchPromises)).forEach(({ url, result }) => fetchResults.set(url, result));

        // Process in original order, preserving side effects (config overrides, providers).
        for (const { trimmedUrl, isHttp } of expandedUrls) {
            if (isHttp) {
                await this.processHttpSubscription(trimmedUrl, fetchResults.get(trimmedUrl) || null, parsedItems, parseSubscriptionContent, fetchSubscriptionWithFormat);
            } else {
                await this.processNonHttpItem(trimmedUrl, parsedItems, parseSubscriptionContent);
            }
        }

        return parsedItems;
    }

    async processHttpSubscription(trimmedUrl, fetchResult, parsedItems, parseSubscriptionContent) {
        if (!fetchResult) return;  // Fetch failed or timed out; skip this source only.

        const { content, format, url: originalUrl, subscriptionUserinfo } = fetchResult;

        if (subscriptionUserinfo && !this.subscriptionUserinfo) {
            this.subscriptionUserinfo = subscriptionUserinfo;
        }

        // If format is compatible with target client, use as provider
        // A node filter forces inline parsing so it applies to all nodes.
        if (!this.proxyFilter && this.isCompatibleProviderFormat(format)) {
            this.providerUrls.push(originalUrl);
            // Content is already fetched; keep node names so country
            // groups can be built over provider members later.
            await this.collectProviderNodeNames(content);
            return;
        }

        // Otherwise parse the content as usual
        const result = parseSubscriptionContent(content);
        if (result && typeof result === 'object' && (result.type === 'yamlConfig' || result.type === 'singboxConfig' || result.type === 'surgeConfig')) {
            if (result.config) {
                this.applyConfigOverrides(result.config);
            }
            if (Array.isArray(result.proxies)) {
                result.proxies.forEach(proxy => {
                    if (proxy && typeof proxy === 'object' && proxy.tag) {
                        parsedItems.push(proxy);
                    }
                });
            }
            return;
        }
        // Handle array of URIs or other formats
        if (Array.isArray(result)) {
            for (const item of result) {
                if (item && typeof item === 'object' && item.tag) {
                    parsedItems.push(item);
                } else if (typeof item === 'string') {
                    const subResult = await ProxyParser.parse(item, this.userAgent);
                    if (subResult) {
                        parsedItems.push(subResult);
                    }
                }
            }
        }
    }

    async processNonHttpItem(processedUrl, parsedItems, parseSubscriptionContent) {
        const result = await ProxyParser.parse(processedUrl, this.userAgent);
        // Handle yamlConfig, singboxConfig, and surgeConfig types (they have the same structure)
        if (result && typeof result === 'object' && (result.type === 'yamlConfig' || result.type === 'singboxConfig' || result.type === 'surgeConfig')) {
            if (result.config) {
                this.applyConfigOverrides(result.config);
            }
            if (Array.isArray(result.proxies)) {
                result.proxies.forEach(proxy => {
                    if (proxy && typeof proxy === 'object' && proxy.tag) {
                        parsedItems.push(proxy);
                    }
                });
            }
            return;
        }
        if (Array.isArray(result)) {
            for (const item of result) {
                if (item && typeof item === 'object' && item.tag) {
                    parsedItems.push(item);
                } else if (typeof item === 'string') {
                    const subResult = await ProxyParser.parse(item, this.userAgent);
                    if (subResult) {
                        parsedItems.push(subResult);
                    }
                }
            }
        } else if (result) {
            parsedItems.push(result);
        }
    }

    /**
     * Check if subscription format is compatible for use as a provider
     * Override in child classes to enable provider support
     * @param {'clash'|'singbox'|'unknown'} format - Detected subscription format
     * @returns {boolean} - True if format can be used as provider
     */
    isCompatibleProviderFormat(format) {
        return false;  // Default: no provider support
    }

    /**
     * Extract node names from an already-fetched provider subscription.
     * Names are only used to enumerate countries for group filters; the nodes
     * themselves stay remote. Best-effort: provider mode must not fail here.
     */
    async collectProviderNodeNames(content) {
        try {
            const { parseSubscriptionContent } = await import('../parsers/subscription/subscriptionContentParser.js');
            const result = parseSubscriptionContent(content);
            const proxies = Array.isArray(result?.proxies) ? result.proxies : [];
            proxies.forEach(proxy => {
                const name = proxy?.tag ?? proxy?.name;
                if (typeof name === 'string' && name.trim()) {
                    this.providerNodeNames.push(name.trim());
                }
            });
        } catch (_) { }
    }

    getAutoProviderDescriptors(reservedNames = []) {
        if (this.autoProviderDescriptors) {
            return this.autoProviderDescriptors;
        }

        const usedNames = new Set(reservedNames);
        const providerNamesByUrl = new Map();
        const descriptors = [];

        for (const url of this.providerUrls) {
            if (typeof url !== 'string' || url.trim() === '') {
                throw new Error('Provider URL must be a non-empty string');
            }

            const normalizedUrl = url.trim();
            if (providerNamesByUrl.has(normalizedUrl)) {
                continue;
            }

            const baseName = createStableProviderName(normalizedUrl);
            let name = baseName;
            let suffix = 2;

            while (usedNames.has(name)) {
                name = `${baseName}_${suffix}`;
                suffix += 1;
            }

            usedNames.add(name);
            providerNamesByUrl.set(normalizedUrl, name);
            descriptors.push({ name, url: normalizedUrl });
        }

        this.autoProviderDescriptors = descriptors;
        return descriptors;
    }

    applyConfigOverrides(overrides) {
        if (!overrides || typeof overrides !== 'object') {
            return;
        }

        // Block keys that are handled specially:
        // - 'proxies': handled by dedicated parser
        // - 'rules', 'rule-providers': generated by our own logic
        // - 'proxy-groups': stored for later intelligent merge (not direct override)
        const blacklistedKeys = new Set(['proxies', 'rules', 'rule-providers', 'proxy-groups']);

        Object.entries(overrides).forEach(([key, value]) => {
            if (blacklistedKeys.has(key)) {
                return;
            }
            if (value === undefined) {
                delete this.config[key];
                this.appliedOverrideKeys.add(key);
            } else if (key === 'dns' && typeof value === 'object' && !Array.isArray(value)) {
                // Special handling for dns object - merge array fields instead of overwriting
                this.config[key] = this.mergeDnsConfig(this.config[key], value);
                this.appliedOverrideKeys.add(key);
            } else {
                this.config[key] = deepCopy(value);
                this.appliedOverrideKeys.add(key);
            }
        });

        // Store user proxy-groups for later merge (after system groups are created)
        if (Array.isArray(overrides['proxy-groups'])) {
            this.pendingUserProxyGroups = this.pendingUserProxyGroups || [];
            this.pendingUserProxyGroups.push(...overrides['proxy-groups']);
        }
    }

    /**
     * Merge DNS configuration with intelligent array merging
     * Arrays like nameserver, fallback, fake-ip-filter are merged instead of overwritten
     * @param {object} existing - Existing DNS config
     * @param {object} incoming - Incoming DNS config to merge
     * @returns {object} - Merged DNS config
     */
    mergeDnsConfig(existing, incoming) {
        if (!existing || typeof existing !== 'object') {
            return deepCopy(incoming);
        }

        const result = deepCopy(existing);
        // Array fields that should be merged instead of overwritten
        const mergeableArrayKeys = new Set(['nameserver', 'fallback', 'fake-ip-filter']);

        Object.entries(incoming).forEach(([key, value]) => {
            if (mergeableArrayKeys.has(key) && Array.isArray(value)) {
                if (Array.isArray(result[key])) {
                    // Merge arrays and deduplicate
                    result[key] = [...new Set([...result[key], ...value])];
                } else {
                    result[key] = deepCopy(value);
                }
            } else if (key === 'nameserver-policy' && typeof value === 'object' && !Array.isArray(value)) {
                // Merge nameserver-policy object
                result[key] = { ...(result[key] || {}), ...deepCopy(value) };
            } else {
                result[key] = deepCopy(value);
            }
        });

        return result;
    }

    hasConfigOverride(key) {
        return this.appliedOverrideKeys?.has(key);
    }

    getSubscriptionUserinfo() {
        return this.subscriptionUserinfo;
    }

    getOutboundsList() {
        let outbounds;
        if (typeof this.selectedRules === 'string' && PREDEFINED_RULE_SETS[this.selectedRules]) {
            outbounds = getOutbounds(PREDEFINED_RULE_SETS[this.selectedRules]);
        } else if (this.selectedRules && Object.keys(this.selectedRules).length > 0) {
            outbounds = getOutbounds(this.selectedRules);
        } else {
            outbounds = getOutbounds(PREDEFINED_RULE_SETS.minimal);
        }
        return outbounds;
    }

    getProxyList() {
        return this.getProxies().map(proxy => this.getProxyName(proxy));
    }

    getProxies() {
        throw new Error('getProxies must be implemented in child class');
    }

    getProxyName(proxy) {
        throw new Error('getProxyName must be implemented in child class');
    }

    convertProxy(proxy) {
        throw new Error('convertProxy must be implemented in child class');
    }

    addProxyToConfig(proxy) {
        throw new Error('addProxyToConfig must be implemented in child class');
    }

    addAutoSelectGroup(proxyList) {
        throw new Error('addAutoSelectGroup must be implemented in child class');
    }

    addNodeSelectGroup(proxyList) {
        throw new Error('addNodeSelectGroup must be implemented in child class');
    }

    addOutboundGroups(outbounds, proxyList) {
        throw new Error('addOutboundGroups must be implemented in child class');
    }

    addCustomRuleGroups(proxyList) {
        throw new Error('addCustomRuleGroups must be implemented in child class');
    }

    addFallBackGroup(proxyList) {
        throw new Error('addFallBackGroup must be implemented in child class');
    }

    addCountryGroups() {
        throw new Error('addCountryGroups must be implemented in child class');
    }

    addCustomItems(customItems) {
        const validItems = (customItems || []).filter(item => item != null);
        const filteredItems = filterProxies(validItems, this.proxyFilter);
        filteredItems.forEach(item => {
            if (item?.tag) {
                const convertedProxy = this.convertProxy(item);
                if (convertedProxy) {
                    this.addProxyToConfig(convertedProxy);
                }
            }
        });
    }

    addSelectors() {
        const outbounds = this.getOutboundsList();
        const proxyList = this.getProxyList();

        this.addAutoSelectGroup(proxyList);
        this.addNodeSelectGroup(proxyList);
        if (this.groupByCountry) {
            this.addCountryGroups();
        }
        this.addOutboundGroups(outbounds, proxyList);
        this.addCustomRuleGroups(proxyList);
        this.addFallBackGroup(proxyList);

        // Merge user-defined proxy-groups after system groups are created
        if (this.pendingUserProxyGroups && this.pendingUserProxyGroups.length > 0) {
            this.mergeUserProxyGroups(this.pendingUserProxyGroups);
        }
    }

    /**
     * Merge user-defined proxy groups with system-generated ones
     * Override in child classes to implement format-specific merge logic
     * @param {Array} userGroups - User-defined proxy groups
     */
    mergeUserProxyGroups(userGroups) {
        // Default: no-op. Child classes implement format-specific merge.
    }

    generateRules() {
        return generateRules(this.selectedRules, this.customRules);
    }

    formatConfig() {
        throw new Error('formatConfig must be implemented in child class');
    }
}
