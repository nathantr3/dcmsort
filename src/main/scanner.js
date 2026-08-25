"use strict";

const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const { Worker } = require("worker_threads");

const BATCH_SIZE = 32;
const WORKER_PATH = path.join(__dirname, "scan-worker.js");

/** Directories that never hold DICOM data and cost real time to walk. */
const SKIP_DIRS = new Set([".git", "node_modules", ".Trash", "$RECYCLE.BIN", "System Volume Information"]);

/** Files that are definitely not DICOM, so we skip even the magic-byte probe. */
const SKIP_EXT = new Set([
    ".txt", ".md", ".json", ".xml", ".html", ".csv", ".pdf", ".zip", ".gz", ".tar",
    ".jpg", ".jpeg", ".png", ".gif", ".tiff", ".bmp", ".mp4", ".mov", ".nii", ".log", ".ds_store"
]);

/** Recursively collect candidate file paths, following no symlinks. */
async function collectFiles(root, onProgress) {
    const files = [];
    const stack = [root];

    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            continue; // unreadable directory: skip rather than abort the scan
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) stack.push(full);
            } else if (entry.isFile()) {
                if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
                if (entry.name === ".DS_Store") continue;
                files.push(full);
                if (files.length % 500 === 0) onProgress?.({ phase: "walk", filesFound: files.length });
            }
        }
    }
    onProgress?.({ phase: "walk", filesFound: files.length });
    return files;
}

class WorkerPool {
    constructor(size) {
        this.workers = Array.from({ length: size }, () => new Worker(WORKER_PATH));
    }
    async destroy() {
        await Promise.all(this.workers.map((w) => w.terminate()));
    }
}

/**
 * Recursively scan `root` and return one metadata record per DICOM file found.
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {(p: object) => void} [opts.onProgress]
 * @param {{cancelled: boolean}} [opts.signal] cooperative cancellation flag
 */
async function scanDirectory(root, { onProgress, signal } = {}) {
    const started = Date.now();
    const files = await collectFiles(root, onProgress);

    const records = [];
    const errors = [];
    let skipped = 0;
    let processed = 0;

    const poolSize = Math.max(1, Math.min(files.length ? Math.ceil(files.length / BATCH_SIZE) : 1, (os.cpus().length || 2) - 1));
    const pool = new WorkerPool(poolSize);

    let cursor = 0;
    let batchId = 0;

    const report = () =>
        onProgress?.({
            phase: "parse",
            filesFound: files.length,
            processed,
            dicomCount: records.length,
            skipped,
            errorCount: errors.length
        });

    try {
        await Promise.all(
            pool.workers.map(
                (worker) =>
                    new Promise((resolve, reject) => {
                        const feed = () => {
                            if (signal?.cancelled || cursor >= files.length) return resolve();
                            const batch = files.slice(cursor, cursor + BATCH_SIZE);
                            cursor += batch.length;
                            worker.postMessage({ type: "batch", batchId: batchId++, files: batch });
                        };

                        worker.on("message", (msg) => {
                            if (msg.type !== "batchDone") return;
                            records.push(...msg.records);
                            errors.push(...msg.errors);
                            skipped += msg.skipped;
                            processed += msg.records.length + msg.errors.length + msg.skipped;
                            report();
                            feed();
                        });
                        worker.on("error", reject);
                        feed();
                    })
            )
        );
    } finally {
        await pool.destroy();
    }

    report();

    // Batches complete out of order across the pool. Downstream, volume
    // numbering is derived from record order and gets baked into saved rule
    // sets, so the scan must produce a stable order regardless of timing.
    records.sort((a, b) => a.filePath.localeCompare(b.filePath));

    return {
        root,
        records,
        errors,
        stats: {
            filesFound: files.length,
            dicomCount: records.length,
            skipped,
            errorCount: errors.length,
            durationMs: Date.now() - started,
            cancelled: Boolean(signal?.cancelled)
        }
    };
}

module.exports = { scanDirectory, collectFiles, SKIP_DIRS };
