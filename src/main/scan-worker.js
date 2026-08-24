"use strict";

/**
 * Worker thread: turn file paths into DICOM metadata records.
 *
 * Parsing dominates scan time, so the pool exists purely to spread that across
 * cores. Work arrives one batch at a time; the parent sends the next batch only
 * after this one is answered, which keeps the queue in the parent and lets a
 * cancel take effect immediately.
 */

const { parentPort } = require("worker_threads");
const { readRecord } = require("./dicom-io");

parentPort.on("message", async (msg) => {
    if (msg.type !== "batch") return;

    const records = [];
    const errors = [];
    let skipped = 0;

    for (const filePath of msg.files) {
        try {
            const record = await readRecord(filePath);
            if (record) records.push(record);
            else skipped++;
        } catch (err) {
            errors.push({ filePath, message: err.message });
        }
    }

    parentPort.postMessage({ type: "batchDone", batchId: msg.batchId, records, errors, skipped });
});
