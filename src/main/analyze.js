"use strict";

/**
 * Volume and phase detection.
 *
 * A DICOM Series is a filing convention, not a description of shape: one series
 * routinely holds several co-located stacks that differ only by reconstruction,
 * each with its own number of temporal phases. This module recovers the actual
 * shape - a list of Volumes, each an (x, y, z, p) matrix of S slices by P
 * phases - so the user can select against it.
 *
 * The pipeline is:
 *   1. split the series into cohorts by an acquisition signature
 *   2. derive a robust slice key from geometry
 *   3. bucket by slice key; equal bucket sizes mean one clean matrix, unequal
 *      sizes mean the cohort holds several volumes
 *   4. choose which attribute orders the phases, since no single tag is reliable
 */

const ROUND_GEOMETRY = 3; // mm; tight enough to separate adjacent slices
const ROUND_DIRECTION = 4;

/* ------------------------------------------------------------------ */
/* Step 1 - cohort signature                                           */
/* ------------------------------------------------------------------ */

/**
 * Fields that describe *how* an image was acquired or reconstructed, rather
 * than where in the stack it sits. Files agreeing on all of these belong to
 * the same logical stack; this is what separates a magnitude stack from the
 * phase-contrast and derived maps filed alongside it in one series.
 */
const COHORT_FIELDS = [
    "imageType",
    "echoNumbers",
    "sequenceName",
    "protocolName",
    "scanningSequence",
    "sequenceVariant",
    "rows",
    "columns",
    "contrastBolusAgent"
];

function round(n, dp) {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    const f = 10 ** dp;
    // The + 0 normalizes -0 to 0 so two files on the same plane hash alike.
    return (Math.round(n * f) + 0) / f;
}

function cohortSignature(r) {
    const parts = COHORT_FIELDS.map((f) => (r[f] === null || r[f] === undefined ? "" : String(r[f])));
    parts.push((r.imageOrientationPatient || []).map((v) => round(v, ROUND_DIRECTION)).join(","));
    parts.push((r.pixelSpacing || []).map((v) => round(v, ROUND_DIRECTION)).join(","));
    return parts.join("|");
}

/** Describe only the cohort fields that actually differ within this series. */
function cohortDistinguishers(records, allCohorts) {
    const sample = records[0];
    const fields = [...COHORT_FIELDS, "echoTime", "flipAngle"];
    const out = [];
    for (const field of fields) {
        const values = new Set(allCohorts.map((c) => String(c[0][field] ?? "")));
        if (values.size > 1 && sample[field] !== null && sample[field] !== undefined) {
            out.push({ field, value: String(sample[field]) });
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Step 2 - slice key                                                  */
/* ------------------------------------------------------------------ */

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Project ImagePositionPatient onto the slice normal. That is the correct
 * ordering scalar for an oblique stack, where SliceLocation is often absent or
 * inconsistently signed. Falls back to SliceLocation, then InstanceNumber.
 *
 * @returns {{ source: string, key: (r: object) => number|null }}
 */
function chooseSliceKey(records) {
    const complete = records.every(
        (r) =>
            Array.isArray(r.imagePositionPatient) &&
            r.imagePositionPatient.length === 3 &&
            Array.isArray(r.imageOrientationPatient) &&
            r.imageOrientationPatient.length === 6
    );

    if (complete && records.length) {
        const iop = records[0].imageOrientationPatient;
        const normal = cross(iop.slice(0, 3), iop.slice(3, 6));
        const mag = Math.hypot(...normal);
        if (mag > 1e-6) {
            const unit = normal.map((v) => v / mag);
            return {
                source: "ImagePositionPatient",
                key: (r) => round(dot(r.imagePositionPatient, unit), ROUND_GEOMETRY)
            };
        }
    }

    if (records.every((r) => Number.isFinite(r.sliceLocation))) {
        return { source: "SliceLocation", key: (r) => round(r.sliceLocation, ROUND_GEOMETRY) };
    }

    return {
        source: "InstanceNumber",
        key: (r) => (Number.isFinite(r.instanceNumber) ? r.instanceNumber : 0)
    };
}

/* ------------------------------------------------------------------ */
/* Step 4 - phase ordering key                                         */
/* ------------------------------------------------------------------ */

/**
 * Ordered by how much we trust them. "Phase index isn't always a reliable
 * DICOM attribute" is the whole reason this list exists: whichever candidate
 * first yields a consistent index across every slice wins, and the choice is
 * surfaced in the UI so the user can override it.
 */
const PHASE_CANDIDATES = [
    { id: "TemporalPositionIdentifier", field: "temporalPositionIdentifier" },
    { id: "TriggerTime", field: "triggerTime" },
    { id: "AcquisitionNumber", field: "acquisitionNumber" },
    { id: "EchoNumbers", field: "echoNumbers" },
    { id: "EchoTime", field: "echoTime" },
    { id: "ContentTime", field: "contentTime" },
    { id: "AcquisitionTime", field: "acquisitionTime" },
    { id: "InstanceNumber", field: "instanceNumber" }
];

function valueOf(record, field) {
    const v = record[field];
    if (v === null || v === undefined || v === "") return null;
    return v;
}

/**
 * Score a candidate against the slice buckets.
 *   2 = P distinct values per bucket AND the same value set in every bucket
 *   1 = P distinct values per bucket, but the sets differ between slices
 *   0 = unusable (values missing, or duplicated within a bucket)
 */
function scorePhaseKey(buckets, field, phases) {
    let firstSet = null;
    let consistent = true;

    for (const bucket of buckets) {
        const values = bucket.map((r) => valueOf(r, field));
        if (values.some((v) => v === null)) return 0;
        const set = new Set(values.map(String));
        if (set.size !== phases) return 0;

        const signature = [...set].sort().join(" ");
        if (firstSet === null) firstSet = signature;
        else if (firstSet !== signature) consistent = false;
    }
    return consistent ? 2 : 1;
}

function rankPhaseKeys(buckets, phases) {
    const scored = [];
    for (const candidate of PHASE_CANDIDATES) {
        const score = scorePhaseKey(buckets, candidate.field, phases);
        if (score > 0) scored.push({ ...candidate, score, rank: PHASE_CANDIDATES.indexOf(candidate) });
    }
    return scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
}

function comparePhaseValues(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build one Volume from records already known to share a phase count.
 * `grid[sliceIndex][phaseIndex]` holds the record for that cell.
 */
function buildVolume({ id, index, records, sliceKeySource, keyFn, phaseKeyOverride }) {
    const byKey = new Map();
    for (const r of records) {
        const k = keyFn(r);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(r);
    }

    const sliceKeys = [...byKey.keys()].sort((a, b) => a - b);
    const buckets = sliceKeys.map((k) => byKey.get(k));
    const phases = buckets[0].length;

    const ranked = rankPhaseKeys(buckets, phases);
    const override = phaseKeyOverride && ranked.find((c) => c.id === phaseKeyOverride);
    const chosen = override || ranked[0] || { id: "InstanceNumber", field: "instanceNumber", score: 0 };

    const grid = buckets.map((bucket) =>
        [...bucket].sort((a, b) => {
            const c = comparePhaseValues(valueOf(a, chosen.field), valueOf(b, chosen.field));
            return c !== 0 ? c : (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0);
        })
    );

    return {
        id,
        index,
        label: `Volume ${index}`,
        slices: sliceKeys.length,
        phases,
        sliceKeys,
        sliceKeySource,
        phaseKey: chosen.id,
        phaseKeyConfident: chosen.score === 2,
        phaseKeyCandidates: ranked.map((c) => ({ id: c.id, score: c.score })),
        grid,
        fileCount: records.length
    };
}

/**
 * Analyze one series.
 *
 * @param {object[]} records metadata records, all from the same series
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.phaseKeyOverrides] volumeId to phase key id
 * @returns {object} series summary carrying a `volumes` array
 */
function analyzeSeries(records, { phaseKeyOverrides = {}, startIndex = 1 } = {}) {
    const warnings = [];
    if (!records.length) return { volumes: [], warnings: ["Series contains no files"] };

    const sample = records[0];

    const cohortMap = new Map();
    for (const r of records) {
        const sig = cohortSignature(r);
        if (!cohortMap.has(sig)) cohortMap.set(sig, []);
        cohortMap.get(sig).push(r);
    }
    // Cohort order fixes volume numbering, and volume ids ("v1") are what a
    // saved rule set refers to. Order by acquisition rather than by whichever
    // file the scan happened to see first.
    const cohorts = [...cohortMap.entries()]
        .map(([signature, group]) => ({
            signature,
            group,
            firstInstance: Math.min(...group.map((r) => (Number.isFinite(r.instanceNumber) ? r.instanceNumber : Infinity)))
        }))
        .sort((a, b) => a.firstInstance - b.firstInstance || a.signature.localeCompare(b.signature))
        .map((c) => c.group);

    const multiFrame = records.filter((r) => Number.isFinite(r.numberOfFrames) && r.numberOfFrames > 1);
    if (multiFrame.length) {
        warnings.push(
            `${multiFrame.length} file(s) are enhanced multi-frame (NumberOfFrames > 1). dcmsort treats each file as one unit and does not split frames.`
        );
    }

    const volumes = [];
    let volumeIndex = startIndex;

    for (const cohortRecords of cohorts) {
        const { source: sliceKeySource, key: keyFn } = chooseSliceKey(cohortRecords);

        const byKey = new Map();
        for (const r of cohortRecords) {
            const k = keyFn(r);
            if (!byKey.has(k)) byKey.set(k, []);
            byKey.get(k).push(r);
        }

        // Slice positions imaged a different number of times cannot share one
        // (x, y, z, p) matrix, so each repeat count becomes its own volume.
        const byRepeatCount = new Map();
        for (const bucket of byKey.values()) {
            const n = bucket.length;
            if (!byRepeatCount.has(n)) byRepeatCount.set(n, []);
            byRepeatCount.get(n).push(...bucket);
        }

        if (byRepeatCount.size > 1) {
            const counts = [...byRepeatCount.keys()].sort((a, b) => a - b).join(", ");
            warnings.push(
                `A cohort did not fit a single (x, y, z, p) matrix: slice positions held ${counts} images. Split into ${byRepeatCount.size} volumes.`
            );
        }

        // Largest phase count first, so the primary dynamic stack leads.
        const groups = [...byRepeatCount.entries()].sort((a, b) => b[0] - a[0]);
        for (const [, groupRecords] of groups) {
            const id = `v${volumeIndex}`;
            const volume = buildVolume({
                id,
                index: volumeIndex,
                records: groupRecords,
                sliceKeySource,
                keyFn,
                phaseKeyOverride: phaseKeyOverrides[id]
            });
            volume.distinguishers = cohortDistinguishers(cohortRecords, cohorts);
            if (!volume.phaseKeyConfident && volume.phases > 1) {
                warnings.push(
                    `${volume.label}: phase order fell back to ${volume.phaseKey}; no attribute gave a consistent index across every slice.`
                );
            }
            volumes.push(volume);
            volumeIndex++;
        }
    }

    return {
        seriesInstanceUID: sample.seriesInstanceUID,
        seriesNumber: sample.seriesNumber,
        seriesDescription: sample.seriesDescription,
        studyInstanceUID: sample.studyInstanceUID,
        modality: sample.modality,
        fileCount: records.length,
        cohortCount: cohorts.length,
        volumes,
        warnings
    };
}

/**
 * Analyze several series as one working set. Volume numbering runs across the
 * whole selection, because the rule editor addresses volumes globally
 * ("FROM Volume 3") regardless of which series they came from.
 *
 * @param {Array<{seriesInstanceUID: string, records: object[]}>} groups
 */
function analyzeSelection(groups, { phaseKeyOverrides = {} } = {}) {
    const series = [];
    const volumes = [];
    let next = 1;

    for (const group of groups) {
        const analysis = analyzeSeries(group.records, { phaseKeyOverrides, startIndex: next });
        next += analysis.volumes.length;
        for (const v of analysis.volumes) {
            v.seriesInstanceUID = analysis.seriesInstanceUID;
            v.seriesDescription = analysis.seriesDescription;
            v.seriesNumber = analysis.seriesNumber;
            volumes.push(v);
        }
        series.push(analysis);
    }

    return {
        series,
        volumes,
        warnings: series.flatMap((s) => s.warnings.map((w) => `Series ${s.seriesNumber ?? "?"}: ${w}`))
    };
}

module.exports = {
    analyzeSeries,
    analyzeSelection,
    chooseSliceKey,
    cohortSignature,
    rankPhaseKeys,
    PHASE_CANDIDATES,
    COHORT_FIELDS
};
