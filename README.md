# comfyui-multi-gpu-dispatch

A small JavaScript library for routing ComfyUI workflows to multiple GPU servers. No dependencies, no build step. Works in any browser or Node.js.

## The problem

ComfyUI runs workflows on one GPU. If you have two (or more) GPUs running separate ComfyUI instances, each loaded with different models, there's no clean way to send the right workflow to the right server and have them work in parallel.

The existing multi-GPU solutions for ComfyUI are custom nodes that split a single workflow across GPUs. That's not what this does. This sits outside ComfyUI entirely. You point it at your servers and tell it which workflow types go where. It handles the dispatch, polling, caching, and result extraction.

## Where this came from

I built this for a project that runs two GPUs: a 5080 for image generation and video, and a 3080 for image editing. They run different models and different workflows, and the whole point is that neither GPU ever has to swap models. The 5080 generates images, the 3080 edits them, and both stay busy at the same time.

I pulled the dispatch layer out of that project and cleaned it up so other people can use it.

## Quick start

Drop `comfyui-dispatch.js` into your project. No npm install needed.

```html
<script src="comfyui-dispatch.js"></script>
<script>
const dispatch = new ComfyUIDispatch({
    servers: {
        fast: 'http://10.0.0.1:8188',
        edit: 'http://10.0.0.2:8188',
    },
    routes: {
        'txt2img': 'fast',
        'img_edit': 'edit',
        'video':   'fast',
    },
});

// Load a workflow exported from ComfyUI
const workflow = await fetch('my_workflow.json').then(r => r.json());

// Modify it and send it off
const wf = new WorkflowBuilder(workflow)
    .set('6', 'text', 'A photo of a red leather jacket, studio lighting')
    .setDimensions('58', 1024, 1024)
    .randomizeSeed('3')
    .build();

const result = await dispatch.run('txt2img', wf);
console.log(result.images[0].url);
</script>
```

Works the same way in Node:

```js
const { ComfyUIDispatch, WorkflowBuilder } = require('./comfyui-dispatch.js');
```
Workflows must be exported in API format. In ComfyUI, enable Dev Mode in settings, then use "Export (API)" instead of the normal save. The API format uses numeric node IDs and is what the /prompt endpoint accepts.

## What it does

**Routing.** You define named servers and map workflow types to them. `txt2img` goes to the fast GPU, `img_edit` goes to the editing GPU, etc.

**Parallel dispatch.** Run jobs on multiple servers at the same time with `runParallel()`. GPU A generates images while GPU B processes edits.

**Polling.** Queue a job via the ComfyUI API and poll `/history` until it's done. Configurable timeouts and intervals.

**Caching.** Results get cached by key. Supports exact matching or fuzzy matching (Levenshtein distance <= 3), which is useful when your prompts come from an LLM that likes to slightly rephrase things between runs.

**Workflow building.** `WorkflowBuilder` gives you a fluent API for modifying workflow JSON: set prompts, randomize seeds, change dimensions, swap image loaders to URL-based loaders (for cross-server references), and prune unused nodes.

**URL compression.** ComfyUI `/view` URLs are long. If you're saving history to localStorage, `compressUrl()` and `decompressUrl()` shrink them down.

## API

### `new ComfyUIDispatch(config)`

```js
const dispatch = new ComfyUIDispatch({
    servers: {
        fast: 'http://10.0.0.1:8188',
        edit: 'http://10.0.0.2:8188',
    },
    routes: {
        'txt2img': 'fast',
        'img_edit': 'edit',
    },
    timeouts: {
        poll: 300000,        // max wait per job (ms), default 5 min
        pollInterval: 1200,  // how often to check (ms), default 1.2s
    },
    cache: {
        enabled: true,       // default true
        fuzzyMatch: false,   // allow near-matches, default false
        maxEntries: 500,     // evicts oldest when full
    },
    onLog: (msg, level) => console.log(`[${level}] ${msg}`),
});
```

### `dispatch.run(type, workflow, overrides?, options?)`

Send a workflow to the right server and wait for the result.

```js
const result = await dispatch.run('txt2img', workflow, {
    '6': { text: 'new prompt' },  // override specific node inputs
}, {
    timeout: 600000,
    cacheKey: 'blue-jacket',
    server: 'fast',        // override the default route
    outputNode: '60',      // only grab outputs from this node
});

result.images   // [{ filename, subfolder, type, url }]
result.videos   // [{ filename, subfolder, type, url }]
result.server   // 'fast'
result.cached   // true or false
```

### `dispatch.runParallel(jobs)`

Fire multiple jobs at once across different servers.

```js
const results = await dispatch.runParallel([
    { type: 'txt2img', workflow: wf1, options: { cacheKey: 'item1' } },
    { type: 'txt2img', workflow: wf2, options: { cacheKey: 'item2' } },
    { type: 'img_edit', workflow: wf3 },
]);
```

Returns `Promise.allSettled` results in the same order.

### `dispatch.uploadImage(file, serverName, filename?)`

Upload an image to a specific ComfyUI instance.

### `dispatch.viewUrl(output, serverName)`

Build a full `/view` URL from an output object.

### `dispatch.compressUrl(url)` / `dispatch.decompressUrl(stored)`

Shrink ComfyUI URLs for storage. `compressUrl` turns a full URL into something like `~0|img_00001_.png|output|output`. `decompressUrl` expands it back.

### `dispatch.getServerLoad()`

Returns in-flight job counts per server: `{ fast: 2, edit: 1 }`.

### `dispatch.pingServer(serverName)`

Returns `true` if the server responds, `false` if not.

### `new WorkflowBuilder(template)`

Fluent builder for modifying ComfyUI workflow JSON before dispatch.

```js
const wf = new WorkflowBuilder(baseWorkflow)
    .set('6', 'text', 'A photo of...')
    .setDimensions('58', 1024, 1024)
    .randomizeSeed('3')
    .randomizeSeed('267:216', 'noise_seed')
    .setImageUrl('78', 'http://...', 'Reference Image')
    .removeNode('137')
    .removeNodes(['128', '135', '136'])
    .build();
```

## How it fits together

```
┌──────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│  Your App    │────>│  ComfyUI Server A    │     │  ComfyUI Server B    │
│              │     │  (generation models) │     │  (editing models)    │
│  dispatch    │ ----│                      │---->│                      │
│  routes jobs │     └──────────┬───────────┘     └──────────┬───────────┘
│  by type     │                │                            │
│              │<────-──────────┘                            │
│              │<────────────────────────────────────────────┘
└──────────────┘
```

The idea: different workflows need different models. Instead of swapping models on one GPU (which is slow), keep each GPU loaded with what it needs and route jobs to the right place. Both GPUs stay busy, no swaps.

## Cross-server image references

GPU B can use images that GPU A generated. ComfyUI's URL-based image loading makes this work:

```js
const genResult = await dispatch.run('txt2img', genWorkflow);
const imageUrl = genResult.images[0].url;

// GPU B fetches the image from GPU A over the network
const editWf = new WorkflowBuilder(editTemplate)
    .setImageUrl('78', imageUrl, 'Source Image')
    .build();

const editResult = await dispatch.run('img_edit', editWf);
```

## Examples

- `examples/quick-start.html` - browser demo with server config and generation
- `examples/example-parallel-pipeline.js` - parallel multi-GPU orchestration with video batching

## Requirements

- One or more ComfyUI instances accessible over HTTP
- A browser with `fetch()` or Node.js 18+
- That's it

## License

MIT
