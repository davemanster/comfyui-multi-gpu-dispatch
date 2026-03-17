/**
 * example-parallel-pipeline.js
 *
 * Demonstrates a real-world pattern: orchestrating multiple ComfyUI servers
 * to run different workflow types in parallel — image generation on one GPU,
 * image editing on another, with results flowing between them.
 *
 * This pattern is useful for:
 *   - Batch product photography (generate base → edit/composite in parallel)
 *   - Comic/storyboard generation (characters on GPU A, backgrounds on GPU B)
 *   - Game asset pipelines (items on one server, portraits on another)
 *   - Any workflow where different tasks have different GPU/model requirements
 */

// Import the dispatch library (use <script> tag in browser, require() in Node)
// const { ComfyUIDispatch, WorkflowBuilder } = require('../comfyui-dispatch.js');

// ============================================================================
// SETUP
// ============================================================================

const dispatch = new ComfyUIDispatch({
    servers: {
        // GPU A: Fast card with large VRAM — handles generation and video
        generator: 'http://10.0.0.1:8188',
        // GPU B: Dedicated to image editing workflows (different model loaded)
        editor:    'http://10.0.0.2:8188',
    },
    routes: {
        'txt2img':    'generator',   // Text-to-image generation
        'img_edit':   'editor',      // Image editing (e.g. outfit swap, inpainting)
        'video':      'generator',   // Image-to-video
    },
    timeouts: {
        poll: 300000,       // 5 minutes default
        pollInterval: 1200, // Check every 1.2s
    },
    cache: {
        enabled: true,
        fuzzyMatch: true,  // Tolerate minor description changes (Levenshtein ≤ 3)
    },
    onLog: (msg, level) => console.log(`[${level}] ${msg}`),
});

// ============================================================================
// WORKFLOW TEMPLATES (loaded from JSON files in production)
// ============================================================================

// These would normally be loaded from .json files exported from ComfyUI.
// Shown inline here for clarity.

const TXT2IMG_TEMPLATE = {
    "3": {
        "inputs": {
            "seed": 0, "steps": 8, "cfg": 1,
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1,
            "model": ["66", 0], "positive": ["6", 0],
            "negative": ["7", 0], "latent_image": ["58", 0]
        },
        "class_type": "KSampler"
    },
    "6":  { "inputs": { "text": "", "clip": ["38", 0] }, "class_type": "CLIPTextEncode" },
    "7":  { "inputs": { "text": "cartoon, anime", "clip": ["38", 0] }, "class_type": "CLIPTextEncode" },
    "58": { "inputs": { "width": 512, "height": 512, "batch_size": 1 }, "class_type": "EmptySD3LatentImage" },
    "60": { "inputs": { "filename_prefix": "output/img", "images": ["8", 0] }, "class_type": "SaveImage" },
    // ... (remaining model loader nodes omitted for brevity)
};

// ============================================================================
// EXAMPLE: PARALLEL PIPELINE
// ============================================================================

/**
 * Generate item images on GPU A, then send them to GPU B for editing,
 * while GPU A continues generating more items. Both GPUs stay busy.
 */
async function runParallelPipeline(items) {
    console.log(`\nStarting pipeline for ${items.length} items...\n`);

    // ── Phase 1: Generate all item images on the generator GPU ──────────
    console.log('Phase 1: Generating item images...');

    const generatedImages = {};
    const BATCH_SIZE = 3; // Concurrent jobs per batch

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(item => {
                const wf = new WorkflowBuilder(TXT2IMG_TEMPLATE)
                    .set('6', 'text', item.prompt)
                    .setDimensions('58', 512, 512)
                    .randomizeSeed('3')
                    .build();

                return dispatch.run('txt2img', wf, {}, {
                    cacheKey: item.description, // Cache by description
                    outputNode: '60',
                });
            })
        );

        results.forEach((result, idx) => {
            const item = batch[idx];
            if (result.status === 'fulfilled') {
                generatedImages[item.id] = result.value;
                const status = result.value.cached ? '(cached)' : '(generated)';
                console.log(`  ✓ ${item.id}: ${item.description} ${status}`);
            } else {
                console.log(`  ✗ ${item.id}: ${result.reason.message}`);
            }
        });
    }

    // ── Phase 2: Parallel work — edit on GPU B while generating more on GPU A ──
    console.log('\nPhase 2: Parallel generation + editing...');

    // GPU B: Start editing with the images we have so far
    const editPromise = runEditsOnGpuB(generatedImages);

    // GPU A: Generate high-res hero images (different workflow, same server)
    const heroPromise = generateHeroImages(items.slice(0, 2));

    // Both GPUs are now working simultaneously
    const [editResults, heroResults] = await Promise.all([editPromise, heroPromise]);

    console.log('\nPipeline complete!');
    console.log(`  Items generated: ${Object.keys(generatedImages).length}`);
    console.log(`  Edits completed: ${editResults.length}`);
    console.log(`  Hero images: ${heroResults.length}`);
    console.log(`  Server load: ${JSON.stringify(dispatch.getServerLoad())}`);
}

async function runEditsOnGpuB(images) {
    const results = [];
    for (const [id, imageData] of Object.entries(images)) {
        if (!imageData.images?.[0]) continue;

        // Build an edit workflow that references the generated image by URL
        // (cross-server: GPU B fetches the image from GPU A's /view endpoint)
        const imageUrl = imageData.images[0].url;

        // In production, you'd load your edit workflow template and use
        // WorkflowBuilder to set the image URL and edit prompt.
        console.log(`  → Editing ${id} on editor GPU (source: ${imageUrl})`);

        // Simulated: dispatch.run('img_edit', editWorkflow, { ... })
        results.push({ id, status: 'edited' });
    }
    return results;
}

async function generateHeroImages(items) {
    const results = [];
    for (const item of items) {
        const wf = new WorkflowBuilder(TXT2IMG_TEMPLATE)
            .set('6', 'text', item.prompt)
            .setDimensions('58', 1200, 1200)  // High-res
            .randomizeSeed('3')
            .build();

        try {
            const result = await dispatch.run('txt2img', wf, {}, {
                cacheKey: `hero_${item.description}`,
                outputNode: '60',
            });
            results.push(result);
            console.log(`  → Hero image for ${item.id}: done`);
        } catch (e) {
            console.log(`  → Hero image for ${item.id}: failed (${e.message})`);
        }
    }
    return results;
}

// ============================================================================
// EXAMPLE: VIDEO QUEUE WITH BATCHED RENDERING
// ============================================================================

/**
 * Demonstrates batching video renders to minimize model swap overhead.
 * Instead of swapping models for each video request, queue them up and
 * render as a batch when the GPU has a natural idle window.
 */
class VideoQueue {
    constructor(dispatch) {
        this.dispatch = dispatch;
        this.queue = [];
        this.rendering = false;
    }

    /** Add a video request to the queue. */
    enqueue(imageUrl, prompt, metadata = {}) {
        this.queue.push({ imageUrl, prompt, metadata, status: 'queued' });
        console.log(`Video queued (${this.queue.length} pending): ${prompt.substring(0, 50)}...`);
    }

    /** Drain the queue — render all queued videos back-to-back. */
    async drain(videoWorkflowTemplate, options = {}) {
        if (this.queue.length === 0) return [];
        if (this.rendering) throw new Error('Already rendering');

        this.rendering = true;
        const results = [];
        const batch = [...this.queue];
        this.queue = [];

        console.log(`\nDraining video queue: ${batch.length} videos`);

        for (const job of batch) {
            job.status = 'rendering';
            try {
                const wf = new WorkflowBuilder(videoWorkflowTemplate)
                    .setImageUrl('276', job.imageUrl)       // Source image
                    .set('267:266', 'value', job.prompt)    // Video prompt
                    .randomizeSeed('267:216', 'noise_seed')
                    .randomizeSeed('267:237', 'noise_seed')
                    .build();

                const result = await this.dispatch.run('video', wf, {}, {
                    timeout: options.timeout || 600000,
                });

                job.status = 'complete';
                job.result = result;
                results.push(job);
                console.log(`  ✓ Video complete: ${job.prompt.substring(0, 40)}...`);
            } catch (e) {
                job.status = 'failed';
                job.error = e.message;
                results.push(job);
                console.log(`  ✗ Video failed: ${e.message}`);
            }
        }

        this.rendering = false;
        console.log(`Video batch complete: ${results.filter(r => r.status === 'complete').length}/${batch.length} succeeded`);
        return results;
    }

    get pending() { return this.queue.length; }
    get isRendering() { return this.rendering; }
}

// ============================================================================
// RUN
// ============================================================================

const sampleItems = [
    { id: 'item_1', description: 'blue denim jacket',  prompt: 'Product photo of a blue denim jacket, white background, studio lighting' },
    { id: 'item_2', description: 'red sneakers',        prompt: 'Product photo of red canvas sneakers, white background, studio lighting' },
    { id: 'item_3', description: 'black leather belt',   prompt: 'Product photo of a black leather belt with silver buckle, white background' },
    { id: 'item_4', description: 'white t-shirt',        prompt: 'Product photo of a plain white crew-neck t-shirt, white background, clean' },
];

// Uncomment to run:
// runParallelPipeline(sampleItems).catch(console.error);
