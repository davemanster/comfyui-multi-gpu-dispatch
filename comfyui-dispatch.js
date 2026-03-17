/**
 * comfyui-dispatch.js
 * 
 * A lightweight JavaScript client for dispatching ComfyUI workflows across
 * multiple GPU servers. Route different workflow types to different backends,
 * poll for results, cache outputs, and orchestrate parallel jobs.
 *
 * No dependencies. Works in any browser or Node.js environment with fetch().
 *
 * Usage:
 *   const dispatch = new ComfyUIDispatch({
 *     servers: {
 *       fast:  'http://10.0.0.1:8188',  // e.g. RTX 5080 — image gen, video
 *       edit:  'http://10.0.0.2:8188',  // e.g. RTX 3080 — image edit
 *     },
 *     routes: {
 *       'txt2img':      'fast',
 *       'img2img_edit': 'edit',
 *       'video':        'fast',
 *     }
 *   });
 *
 *   const result = await dispatch.run('txt2img', workflow, { seed: 42 });
 */

class ComfyUIDispatch {

    /**
     * @param {Object} config
     * @param {Object} config.servers        - Named server URLs: { name: 'http://host:port' }
     * @param {Object} [config.routes]       - Workflow-type → server-name mapping
     * @param {Object} [config.timeouts]     - { poll: 300000, pollInterval: 1200 }
     * @param {Object} [config.cache]        - { enabled: true, fuzzyMatch: false, maxEntries: 500 }
     * @param {Function} [config.onLog]      - Optional logging callback: (msg, level) => {}
     */
    constructor(config) {
        this.servers = config.servers || {};
        this.routes = config.routes || {};
        this.timeouts = {
            poll: config.timeouts?.poll || 300000,
            pollInterval: config.timeouts?.pollInterval || 1200,
        };
        this.cacheConfig = {
            enabled: config.cache?.enabled !== false,
            fuzzyMatch: config.cache?.fuzzyMatch || false,
            maxEntries: config.cache?.maxEntries || 500,
        };
        this.onLog = config.onLog || (() => {});

        this.clientId = this._generateId();
        this._cache = new Map();
        this._serverStatus = {};

        // Track in-flight jobs per server for load awareness
        this._inflightCounts = {};
        for (const name of Object.keys(this.servers)) {
            this._inflightCounts[name] = 0;
        }
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Run a workflow on the appropriate server.
     *
     * @param {string} workflowType   - Key matching a route (e.g. 'txt2img')
     * @param {Object} workflow       - ComfyUI workflow JSON (will be deep-cloned)
     * @param {Object} [overrides]    - Node overrides: { nodeId: { inputName: value } }
     * @param {Object} [options]      - { timeout, cacheKey, server, outputNode }
     * @returns {Promise<Object>}     - { images, videos, raw, server, promptId, cached }
     */
    async run(workflowType, workflow, overrides = {}, options = {}) {
        const cacheKey = options.cacheKey || null;

        // Check cache
        if (cacheKey && this.cacheConfig.enabled) {
            const cached = this._cacheGet(cacheKey);
            if (cached) {
                this.onLog(`Cache hit: ${cacheKey}`, 'info');
                return { ...cached, cached: true };
            }
        }

        // Resolve server
        const serverName = options.server || this.routes[workflowType] || Object.keys(this.servers)[0];
        const serverUrl = this.servers[serverName];
        if (!serverUrl) throw new Error(`Unknown server: ${serverName}`);

        // Clone and apply overrides
        const wf = JSON.parse(JSON.stringify(workflow));
        for (const [nodeId, inputs] of Object.entries(overrides)) {
            if (wf[nodeId]?.inputs) {
                Object.assign(wf[nodeId].inputs, inputs);
            }
        }

        // Dispatch
        this._inflightCounts[serverName]++;
        this.onLog(`Queuing ${workflowType} on ${serverName} (${serverUrl})`, 'info');

        try {
            const promptId = await this._queuePrompt(wf, serverUrl);
            this.onLog(`Queued: ${promptId} on ${serverName}`, 'info');

            const timeout = options.timeout || this.timeouts.poll;
            const histData = await this._pollHistory(promptId, serverUrl, timeout);

            const result = this._extractOutputs(histData, promptId, serverUrl, options.outputNode);
            result.server = serverName;
            result.promptId = promptId;
            result.cached = false;

            // Cache result
            if (cacheKey && this.cacheConfig.enabled) {
                this._cacheSet(cacheKey, result);
            }

            return result;
        } finally {
            this._inflightCounts[serverName]--;
        }
    }

    /**
     * Run multiple workflows in parallel across different servers.
     * Each job is { type, workflow, overrides, options }.
     *
     * @param {Array<Object>} jobs
     * @returns {Promise<Array<Object>>} - Settled results (same order as input)
     */
    async runParallel(jobs) {
        const promises = jobs.map(job =>
            this.run(job.type, job.workflow, job.overrides || {}, job.options || {})
        );
        return Promise.allSettled(promises);
    }

    /**
     * Upload an image to a specific server's ComfyUI instance.
     *
     * @param {File|Blob} file
     * @param {string} serverName
     * @param {string} [filename]
     * @returns {Promise<Object>} - Upload response from ComfyUI
     */
    async uploadImage(file, serverName, filename) {
        const serverUrl = this.servers[serverName];
        if (!serverUrl) throw new Error(`Unknown server: ${serverName}`);

        const formData = new FormData();
        formData.append('image', file, filename || file.name || 'upload.png');
        formData.append('overwrite', 'true');

        const res = await fetch(`${serverUrl}/upload/image`, { method: 'POST', body: formData });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        return res.json();
    }

    /**
     * Build a ComfyUI /view URL for a given output.
     *
     * @param {Object} output    - { filename, subfolder, type }
     * @param {string} serverName
     * @returns {string}
     */
    viewUrl(output, serverName) {
        const base = this.servers[serverName];
        if (!base) throw new Error(`Unknown server: ${serverName}`);
        return `${base}/view?filename=${encodeURIComponent(output.filename)}&subfolder=${encodeURIComponent(output.subfolder || '')}&type=${output.type || 'output'}`;
    }

    /**
     * Compress a ComfyUI view URL into a compact storable string.
     * Useful for saving history to localStorage without bloating storage.
     *
     * @param {string} url
     * @returns {string} - Compact representation or original URL if not recognized
     */
    compressUrl(url) {
        const names = Object.keys(this.servers);
        for (let i = 0; i < names.length; i++) {
            const base = this.servers[names[i]];
            if (url.startsWith(base + '/view?')) {
                const params = new URL(url).searchParams;
                return `~${i}|${params.get('filename') || ''}|${params.get('subfolder') || ''}|${params.get('type') || 'output'}`;
            }
        }
        return url;
    }

    /**
     * Decompress a previously compressed URL back to a full ComfyUI view URL.
     *
     * @param {string} stored
     * @returns {string}
     */
    decompressUrl(stored) {
        if (!stored || !stored.startsWith('~')) return stored;
        const [idx, filename, subfolder, type] = stored.substring(1).split('|');
        const names = Object.keys(this.servers);
        const base = this.servers[names[parseInt(idx)]] || Object.values(this.servers)[0];
        return `${base}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`;
    }

    /**
     * Get current in-flight job counts per server.
     * Useful for building load-aware UIs or custom routing.
     *
     * @returns {Object} - { serverName: count }
     */
    getServerLoad() {
        return { ...this._inflightCounts };
    }

    /**
     * Check if a server is reachable.
     *
     * @param {string} serverName
     * @returns {Promise<boolean>}
     */
    async pingServer(serverName) {
        const url = this.servers[serverName];
        if (!url) return false;
        try {
            const res = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(5000) });
            this._serverStatus[serverName] = res.ok;
            return res.ok;
        } catch {
            this._serverStatus[serverName] = false;
            return false;
        }
    }

    /**
     * Clear the result cache.
     */
    clearCache() {
        this._cache.clear();
    }

    // =========================================================================
    // COMFYUI API (PRIVATE)
    // =========================================================================

    async _queuePrompt(workflow, serverUrl) {
        const res = await fetch(`${serverUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Queue failed (${res.status}): ${text}`);
        }
        const data = await res.json();
        if (data.error) throw new Error(JSON.stringify(data.error));
        return data.prompt_id;
    }

    async _pollHistory(promptId, serverUrl, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const res = await fetch(`${serverUrl}/history/${promptId}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data[promptId]) return data;
                }
            } catch (e) {
                // Server may be busy; keep polling
            }
            await new Promise(r => setTimeout(r, this.timeouts.pollInterval));
        }
        throw new Error(`Generation timed out after ${timeoutMs}ms`);
    }

    // =========================================================================
    // OUTPUT EXTRACTION
    // =========================================================================

    _extractOutputs(histData, promptId, serverUrl, outputNodeId) {
        const outputs = histData[promptId]?.outputs || {};
        const result = { images: [], videos: [], raw: outputs };

        const targetNodes = outputNodeId ? [outputNodeId] : Object.keys(outputs);

        for (const nodeId of targetNodes) {
            const nodeOut = outputs[nodeId];
            if (!nodeOut) continue;

            if (nodeOut.images) {
                for (const img of nodeOut.images) {
                    result.images.push({
                        ...img,
                        url: this._buildViewUrl(img, serverUrl),
                    });
                }
            }
            if (nodeOut.videos) {
                for (const vid of nodeOut.videos) {
                    result.videos.push({
                        ...vid,
                        url: this._buildViewUrl(vid, serverUrl),
                    });
                }
            }
            // Some workflows output video as gifs
            if (nodeOut.gifs) {
                for (const gif of nodeOut.gifs) {
                    result.videos.push({
                        ...gif,
                        url: this._buildViewUrl(gif, serverUrl),
                    });
                }
            }
        }

        return result;
    }

    _buildViewUrl(output, serverUrl) {
        return `${serverUrl}/view?filename=${encodeURIComponent(output.filename)}&subfolder=${encodeURIComponent(output.subfolder || '')}&type=${output.type || 'output'}`;
    }

    // =========================================================================
    // CACHING
    // =========================================================================

    _cacheGet(key) {
        const normalized = key.toLowerCase().trim();
        if (this._cache.has(normalized)) return this._cache.get(normalized);

        if (this.cacheConfig.fuzzyMatch) {
            for (const [k, v] of this._cache) {
                if (this._levenshtein(normalized, k) <= 3) return v;
            }
        }
        return null;
    }

    _cacheSet(key, value) {
        const normalized = key.toLowerCase().trim();
        // Evict oldest if at capacity
        if (this._cache.size >= this.cacheConfig.maxEntries) {
            const oldest = this._cache.keys().next().value;
            this._cache.delete(oldest);
        }
        this._cache.set(normalized, value);
    }

    _levenshtein(a, b) {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                matrix[i][j] = b[i - 1] === a[j - 1]
                    ? matrix[i - 1][j - 1]
                    : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
            }
        }
        return matrix[b.length][a.length];
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================

    _generateId() {
        return 'dispatch_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    }
}

// ============================================================================
// WORKFLOW BUILDER — helper for dynamically constructing ComfyUI workflow JSON
// ============================================================================

class WorkflowBuilder {
    /**
     * Create a builder from a base workflow template.
     * @param {Object} template - ComfyUI workflow JSON
     */
    constructor(template) {
        this.workflow = JSON.parse(JSON.stringify(template));
    }

    /**
     * Set an input value on a specific node.
     * @param {string} nodeId
     * @param {string} inputName
     * @param {*} value
     * @returns {WorkflowBuilder} - for chaining
     */
    set(nodeId, inputName, value) {
        if (!this.workflow[nodeId]) throw new Error(`Node ${nodeId} not found in workflow`);
        this.workflow[nodeId].inputs[inputName] = value;
        return this;
    }

    /**
     * Randomize a seed input on a node.
     * @param {string} nodeId
     * @param {string} [inputName='seed']
     * @returns {WorkflowBuilder}
     */
    randomizeSeed(nodeId, inputName = 'seed') {
        return this.set(nodeId, inputName, Math.floor(Math.random() * 1e15));
    }

    /**
     * Set image dimensions on an EmptyLatentImage-type node.
     * @param {string} nodeId
     * @param {number} width
     * @param {number} height
     * @returns {WorkflowBuilder}
     */
    setDimensions(nodeId, width, height) {
        return this.set(nodeId, 'width', width).set(nodeId, 'height', height);
    }

    /**
     * Replace a LoadImage node with a URL-based loader.
     * Useful for cross-server image references.
     * @param {string} nodeId
     * @param {string} url
     * @param {string} [title]
     * @returns {WorkflowBuilder}
     */
    setImageUrl(nodeId, url, title) {
        this.workflow[nodeId] = {
            inputs: { url },
            class_type: 'Load Image From Url (mtb)',
            _meta: { title: title || 'Load Image' },
        };
        return this;
    }

    /**
     * Remove a node from the workflow.
     * Useful for pruning unused branches that would cause validation errors.
     * @param {string} nodeId
     * @returns {WorkflowBuilder}
     */
    removeNode(nodeId) {
        delete this.workflow[nodeId];
        return this;
    }

    /**
     * Remove multiple nodes.
     * @param {string[]} nodeIds
     * @returns {WorkflowBuilder}
     */
    removeNodes(nodeIds) {
        nodeIds.forEach(id => delete this.workflow[id]);
        return this;
    }

    /**
     * Get the built workflow, ready for dispatch.
     * @returns {Object}
     */
    build() {
        return this.workflow;
    }
}

// Export for both ES modules and CommonJS
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ComfyUIDispatch, WorkflowBuilder };
}
