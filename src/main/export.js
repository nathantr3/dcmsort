"use strict";

/**
 * Writes a resolved plan out as DICOM files, either replacing the sources in
 * place or building a fresh tree.
 *
 * Two invariants drive the design:
 *  - one bad file never aborts the run; it is recorded and the export continues
 *  - an in-place write is never partial, so every file is staged to a temporary
 *    path and renamed over the target only once it is fully written
 */

const fsp = require("fs/promises");
const path = require("path");

const io = require("./dicom-io");
const { T } = require("./tags");

/** Strip characters that are illegal or awkward in a path segment. */
function sanitize(text, fallback = "unnamed") {
    const cleaned = String(text ?? "")
        .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/\.+$/, ""); // Windows rejects trailing dots
    return cleaned.slice(0, 80) || fallback;
}

function seriesFolderName(childSeries) {
    const number = Number.isFinite(childSeries.seriesNumber) ? childSeries.seriesNumber : 0;
    return `${String(number).padStart(3, "0")}_${sanitize(childSeries.seriesDescription, childSeries.label)}`;
}

/**
 * Where each output file goes.
 *
 * In-place, the first child series to claim a file overwrites it; any further
 * claim cannot share that path, so it is written beside the source with the
 * child series id appended rather than silently dropped.
 */
function planOutputPath({ cell, childSeries, target, claimIndex }) {
    const source = cell.record.filePath;

    if (target.mode === "in-place") {
        if (claimIndex === 0) return source;
        const dir = path.dirname(source);
        const ext = path.extname(source);
        const stem = path.basename(source, ext);
        return path.join(dir, `${stem}_${childSeries.id}${ext || ".dcm"}`);
    }

    const study = sanitize(cell.record.studyDescription || cell.record.studyInstanceUID, "study");
    return path.join(
        target.outputDir,
        study,
        seriesFolderName(childSeries),
        `IM-${String(cell.outputInstanceNumber).padStart(5, "0")}.dcm`
    );
}

/** Apply one child series' attribute edits to a parsed file. */
function applyAttributes({ dicomDict, cell, childSeries, seriesInstanceUID, needsNewSopUID }) {
    const attrs = childSeries.attributes;

    if (seriesInstanceUID) io.setTag(dicomDict, T.SeriesInstanceUID, seriesInstanceUID);
    if (Number.isFinite(childSeries.seriesNumber)) io.setTag(dicomDict, T.SeriesNumber, childSeries.seriesNumber);
    if (childSeries.seriesDescription) io.setTag(dicomDict, T.SeriesDescription, childSeries.seriesDescription);
    if (attrs.renumberInstances) io.setTag(dicomDict, T.InstanceNumber, cell.outputInstanceNumber);

    // A source file claimed by more than one child series would otherwise ship
    // the same SOPInstanceUID under two SeriesInstanceUIDs, which PACS reject.
    const sopUID = needsNewSopUID ? io.newUID() : io.getStr(dicomDict.dict, T.SOPInstanceUID);
    if (needsNewSopUID) io.setTag(dicomDict, T.SOPInstanceUID, sopUID);
    if (sopUID) io.setTag(dicomDict, T.MediaStorageSOPInstanceUID, sopUID, "meta");

    return sopUID;
}

async function writeAtomically(dicomDict, outPath) {
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    const tmp = `${outPath}.dcmsort-tmp`;
    try {
        await io.writeDict(dicomDict, tmp);
        await fsp.rename(tmp, outPath);
    } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
    }
}

/**
 * Run an export.
 *
 * @param {object} plan result of rules.resolveRuleSet
 * @param {{mode: "in-place"|"new-folder", outputDir?: string}} target
 * @param {object} [opts]
 * @param {(p: object) => void} [opts.onProgress]
 * @param {{cancelled: boolean}} [opts.signal]
 */
async function exportPlan(plan, target, { onProgress, signal } = {}) {
    if (target.mode === "new-folder" && !target.outputDir) {
        throw new Error("An output folder is required for a new-folder export");
    }

    const started = Date.now();
    const active = plan.childSeries.filter((cs) => cs.fileCount > 0);
    const totalFiles = active.reduce((n, cs) => n + cs.fileCount, 0);

    const errors = [];
    const written = [];
    const seriesUIDs = {};
    const claimCount = new Map(); // source path -> how many child series already took it
    const usedPaths = new Set();
    let processed = 0;

    for (const childSeries of active) {
        if (signal?.cancelled) break;

        const uid = childSeries.attributes.newSeriesInstanceUID
            ? io.newUID()
            : childSeries.cells[0]?.record.seriesInstanceUID;
        seriesUIDs[childSeries.id] = uid;

        for (const cell of childSeries.cells) {
            if (signal?.cancelled) break;

            const source = cell.record.filePath;
            const claimIndex = claimCount.get(source) ?? 0;
            claimCount.set(source, claimIndex + 1);

            try {
                let outPath = planOutputPath({ cell, childSeries, target, claimIndex });

                // Distinct sources can collide on one output name when a join
                // pulls equal instance numbers from two series; keep both.
                if (usedPaths.has(outPath)) {
                    const ext = path.extname(outPath);
                    outPath = `${outPath.slice(0, -ext.length || undefined)}_${processed}${ext}`;
                }
                usedPaths.add(outPath);

                const dicomDict = await io.readFull(source);
                applyAttributes({
                    dicomDict,
                    cell,
                    childSeries,
                    seriesInstanceUID: uid,
                    needsNewSopUID: claimIndex > 0
                });
                await writeAtomically(dicomDict, outPath);
                written.push({ childSeriesId: childSeries.id, source, outPath });
            } catch (err) {
                errors.push({ filePath: source, childSeriesId: childSeries.id, message: err.message });
            }

            processed++;
            onProgress?.({
                processed,
                totalFiles,
                written: written.length,
                errorCount: errors.length,
                currentChildSeries: childSeries.label
            });
        }
    }

    return {
        target,
        seriesUIDs,
        written,
        errors,
        stats: {
            totalFiles,
            writtenCount: written.length,
            errorCount: errors.length,
            durationMs: Date.now() - started,
            cancelled: Boolean(signal?.cancelled)
        }
    };
}

module.exports = { exportPlan, sanitize, seriesFolderName, planOutputPath };
