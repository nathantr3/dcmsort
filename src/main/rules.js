"use strict";

/**
 * The rule engine: turn a saved rule set into a concrete plan of which files
 * land in which output series, carrying which attributes.
 *
 * A rule set is the document the GUI edits and `saveRuleSet` persists. Each
 * child series is one output series, defined by selections that read as
 * "FROM volume 1 SELECT slices * AND phases 1-3", plus the attribute edits to
 * apply to whatever those selections match.
 */

const RULESET_VERSION = 1;

/**
 * Twelve hues that stay distinguishable from one another on the dark surface
 * and remain separable for the common forms of colour vision deficiency.
 */
const PALETTE = [
    "#4EC9B0", "#569CD6", "#C586C0", "#DCDCAA",
    "#CE9178", "#9CDCFE", "#B5CEA8", "#D16969",
    "#4FC1FF", "#E9A66C", "#7FB3D5", "#F2A2C0"
];

function paletteColor(index) {
    return PALETTE[index % PALETTE.length];
}

/* ------------------------------------------------------------------ */
/* Range syntax                                                        */
/* ------------------------------------------------------------------ */

const SINGLE_RE = /^(-?\d+)$/;
const RANGE_RE = /^(-?\d+)?\s*-\s*(-?\d+)?(?::(\d+))?$/;

class RangeError_ extends Error {}

/** Map a possibly-negative 1-based index onto 1..max. -1 is the last item. */
function normalizeIndex(n, max) {
    const idx = n < 0 ? max + n + 1 : n;
    if (idx < 1 || idx > max) {
        throw new RangeError_(`index ${n} is outside 1..${max}`);
    }
    return idx;
}

/**
 * Parse a selection range into sorted, de-duplicated 1-based indices.
 *
 * Accepts `*` or empty (all), `4`, `-1` (last), `1-3`, `3-` (to the end),
 * `1-9:2` (stride), and comma-separated combinations of those.
 *
 * @param {string} spec
 * @param {number} max size of the axis being selected
 * @returns {number[]}
 */
function parseRange(spec, max) {
    if (max <= 0) return [];
    const text = String(spec ?? "").trim();
    if (text === "" || text === "*") return Array.from({ length: max }, (_, i) => i + 1);

    const picked = new Set();

    for (const rawTerm of text.split(",")) {
        const term = rawTerm.trim();
        if (!term) continue;

        const single = term.match(SINGLE_RE);
        if (single) {
            picked.add(normalizeIndex(Number(single[1]), max));
            continue;
        }

        const range = term.match(RANGE_RE);
        if (!range) throw new RangeError_(`cannot parse "${term}"`);

        const start = range[1] === undefined ? 1 : normalizeIndex(Number(range[1]), max);
        const end = range[2] === undefined ? max : normalizeIndex(Number(range[2]), max);
        const stride = range[3] === undefined ? 1 : Number(range[3]);
        if (stride < 1) throw new RangeError_(`stride must be at least 1 in "${term}"`);

        const step = start <= end ? stride : -stride;
        for (let i = start; step > 0 ? i <= end : i >= end; i += step) picked.add(i);
    }

    return [...picked].sort((a, b) => a - b);
}

/** Render indices back to the compact syntax, for UI summaries. */
function formatRange(indices, max) {
    if (!indices.length) return "(none)";
    if (indices.length === max) return "*";
    const parts = [];
    let start = indices[0];
    let prev = indices[0];
    for (let i = 1; i <= indices.length; i++) {
        const cur = indices[i];
        if (cur === prev + 1) {
            prev = cur;
            continue;
        }
        parts.push(start === prev ? `${start}` : `${start}-${prev}`);
        start = cur;
        prev = cur;
    }
    return parts.join(",");
}

/* ------------------------------------------------------------------ */
/* Rule set construction                                               */
/* ------------------------------------------------------------------ */

function defaultAttributes() {
    return {
        seriesNumberMode: "scaleOffset", // or "absolute"
        seriesScale: 100,
        seriesOffset: 1,
        seriesNumberAbsolute: null,

        descriptionMode: "affix", // or "replace"
        descriptionNew: null,
        descriptionStripPrefix: null,
        descriptionPrefix: null,
        descriptionSuffix: null,
        stripExistingPrefix: false,

        newSeriesInstanceUID: true,
        renumberInstances: true,
        instanceOrder: "phase-major" // or "slice-major"
    };
}

function makeChildSeries(index, overrides = {}) {
    return {
        id: `cs-${index + 1}`,
        label: `Child series ${index + 1}`,
        color: paletteColor(index),
        selections: [],
        attributes: defaultAttributes(),
        ...overrides
    };
}

function emptyRuleSet(sourceSeriesUIDs = []) {
    return { version: RULESET_VERSION, sourceSeries: [...sourceSeriesUIDs], childSeries: [] };
}

/**
 * A compact shape signature per volume, stored with a saved rule set.
 *
 * Volume ids are positional ("v1"), so a rule file only means what it says as
 * long as re-analysis produces the same volumes. Recording the shapes lets a
 * later load tell the user their rules no longer line up instead of quietly
 * selecting the wrong images.
 */
function fingerprintVolumes(analysis) {
    const out = {};
    for (const v of analysis.volumes) {
        out[v.id] = `${v.slices}x${v.phases}@${v.seriesNumber ?? "?"}`;
    }
    return out;
}

/** Compare a saved rule set's fingerprints against a fresh analysis. */
function checkRuleSetFit(ruleSet, analysis) {
    const current = fingerprintVolumes(analysis);
    const saved = ruleSet?.volumeFingerprints;
    const problems = [];

    const referenced = new Set(
        (ruleSet?.childSeries || []).flatMap((cs) => (cs.selections || []).map((s) => s.volumeId))
    );

    for (const volumeId of referenced) {
        if (!current[volumeId]) {
            problems.push({ level: "error", volumeId, message: `${volumeId} does not exist in the current selection.` });
        } else if (saved && saved[volumeId] && saved[volumeId] !== current[volumeId]) {
            problems.push({
                level: "warning",
                volumeId,
                message: `${volumeId} was ${saved[volumeId]} when these rules were saved but is ${current[volumeId]} now.`
            });
        }
    }
    return problems;
}

/** Fill in anything a hand-edited or older rule file left out. */
function normalizeRuleSet(ruleSet) {
    const childSeries = (ruleSet?.childSeries || []).map((cs, i) => ({
        ...makeChildSeries(i),
        ...cs,
        attributes: { ...defaultAttributes(), ...(cs.attributes || {}) },
        selections: (cs.selections || []).map((s) => ({ volumeId: s.volumeId, slices: s.slices ?? "*", phases: s.phases ?? "*" }))
    }));
    return {
        version: RULESET_VERSION,
        sourceSeries: ruleSet?.sourceSeries || [],
        volumeFingerprints: ruleSet?.volumeFingerprints || null,
        childSeries
    };
}

/* ------------------------------------------------------------------ */
/* Attribute computation (mirrors dcmsplit's formulas)                 */
/* ------------------------------------------------------------------ */

/**
 * dcmsplit: frameSeriesNumber = seriesScale * baseSeries + seriesOffset.
 * `absolute` mode bypasses the formula for users who just want to type 301.
 */
function computeSeriesNumber(attributes, baseSeriesNumber) {
    if (attributes.seriesNumberMode === "absolute") {
        const n = Number(attributes.seriesNumberAbsolute);
        return Number.isFinite(n) ? n : null;
    }
    const base = Number.isFinite(baseSeriesNumber) ? baseSeriesNumber : 0;
    const scale = Number.isFinite(Number(attributes.seriesScale)) ? Number(attributes.seriesScale) : 1;
    const offset = Number.isFinite(Number(attributes.seriesOffset)) ? Number(attributes.seriesOffset) : 0;
    return scale * base + offset;
}

/**
 * Remove a prefix and any trailing whitespace/colon, case-insensitively.
 * Ported from dcmsplit's stripPrefix (internal/dicom/processor.go:389-393) so
 * re-running a prefix does not stack it up on repeated exports.
 */
function stripPrefix(text, prefix) {
    if (!prefix) return text;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`^${escaped}\\s*:?\\s*`, "i"), "").trim();
}

/**
 * Build the output Series Description, in this order:
 *   1. strip descriptionStripPrefix from the original, if set
 *   2. strip descriptionPrefix too, if stripExistingPrefix is on
 *   3. replace mode: descriptionNew stands in for what is left entirely
 *      affix mode:   descriptionNew becomes a "label: " ahead of it
 *   4. wrap in descriptionPrefix and descriptionSuffix
 *
 * Steps 1 and 4 are independent, so "strip NOT DIAGNOSTIC:, add My Feature:"
 * is a single rule.
 */
function computeDescription(attributes, originalDescription) {
    let body = originalDescription || "";

    // Removing an unwanted prefix and adding a new one are separate intents:
    // "drop NOT DIAGNOSTIC:, then add My Feature:". descriptionStripPrefix is
    // whatever should come off, independent of what goes on.
    if (attributes.descriptionStripPrefix) {
        body = stripPrefix(body, attributes.descriptionStripPrefix);
    }
    // stripExistingPrefix is the narrower case of removing the prefix we are
    // about to add, so re-exporting a folder does not stack it up.
    if (attributes.stripExistingPrefix && attributes.descriptionPrefix) {
        body = stripPrefix(body, attributes.descriptionPrefix);
    }
    if (attributes.descriptionMode === "replace") {
        body = attributes.descriptionNew || "";
    } else if (attributes.descriptionNew) {
        // In affix mode a "new" value is a label placed ahead of the original,
        // matching dcmsplit's "<frame>: <original>" convention.
        body = body ? `${attributes.descriptionNew}: ${body}` : attributes.descriptionNew;
    }

    const parts = [];
    if (attributes.descriptionPrefix) parts.push(attributes.descriptionPrefix);
    if (body) parts.push(body);
    let out = parts.join(" ").trim();
    if (attributes.descriptionSuffix) out = `${out}${out ? " " : ""}${attributes.descriptionSuffix}`.trim();

    // LO has a hard 64-character limit; silently over-long values get rejected
    // by some receivers, so truncate here where we can warn about it.
    return out.slice(0, 64);
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve a rule set against an analysis into a concrete export plan.
 *
 * @param {object} ruleSet
 * @param {{volumes: object[]}} analysis result of analyzeSelection
 * @returns {{childSeries: object[], assignmentsByPath: Map, conflicts: object[]}}
 */
function resolveRuleSet(ruleSet, analysis) {
    const normalized = normalizeRuleSet(ruleSet);
    const volumesById = new Map(analysis.volumes.map((v) => [v.id, v]));
    const conflicts = [];
    const claimsByPath = new Map();
    const resolved = [];

    for (const cs of normalized.childSeries) {
        const cells = [];
        const seen = new Set();
        // How many files each selection contributed, for the per-row count in
        // the editor. A file already taken by an earlier selection in the same
        // child series is not counted twice.
        const selectionCounts = [];

        for (const [i, selection] of cs.selections.entries()) {
            selectionCounts[i] = 0;
            const volume = volumesById.get(selection.volumeId);
            if (!volume) {
                conflicts.push({
                    level: "error",
                    childSeriesId: cs.id,
                    message: `${cs.label}: selection ${i + 1} refers to an unknown volume (${selection.volumeId}).`
                });
                continue;
            }

            let sliceIdx;
            let phaseIdx;
            try {
                sliceIdx = parseRange(selection.slices, volume.slices);
                phaseIdx = parseRange(selection.phases, volume.phases);
            } catch (err) {
                conflicts.push({
                    level: "error",
                    childSeriesId: cs.id,
                    message: `${cs.label}: selection ${i + 1} on ${volume.label} - ${err.message}.`
                });
                continue;
            }

            for (const p of phaseIdx) {
                for (const s of sliceIdx) {
                    const record = volume.grid[s - 1][p - 1];
                    // A file selected twice by one child series is written once.
                    if (seen.has(record.filePath)) continue;
                    seen.add(record.filePath);
                    selectionCounts[i]++;
                    cells.push({ record, volumeId: volume.id, sliceIndex: s, phaseIndex: p });
                }
            }
        }

        // Instance order decides how a viewer scrolls the output series:
        // phase-major keeps each 3D volume contiguous, slice-major keeps each
        // slice's time course contiguous.
        const order = cs.attributes.instanceOrder === "slice-major"
            ? (a, b) => a.sliceIndex - b.sliceIndex || a.phaseIndex - b.phaseIndex
            : (a, b) => a.phaseIndex - b.phaseIndex || a.sliceIndex - b.sliceIndex;
        cells.sort((a, b) => order(a, b) || a.volumeId.localeCompare(b.volumeId));

        cells.forEach((cell, i) => {
            cell.outputInstanceNumber = i + 1;
            if (!claimsByPath.has(cell.record.filePath)) claimsByPath.set(cell.record.filePath, []);
            claimsByPath.get(cell.record.filePath).push(cs.id);
        });

        if (!cells.length) {
            conflicts.push({
                level: "warning",
                childSeriesId: cs.id,
                message: `${cs.label} matches no files.`
            });
        }

        const base = cells[0]?.record;
        const baseNumbers = new Set(cells.map((c) => c.record.seriesNumber));
        const baseDescriptions = new Set(cells.map((c) => c.record.seriesDescription));
        if (baseNumbers.size > 1 && cs.attributes.seriesNumberMode === "scaleOffset") {
            conflicts.push({
                level: "warning",
                childSeriesId: cs.id,
                message: `${cs.label} joins files from series ${[...baseNumbers].join(", ")}; the scale/offset formula uses ${base?.seriesNumber} as the base.`
            });
        }

        resolved.push({
            ...cs,
            cells,
            selectionCounts,
            fileCount: cells.length,
            baseSeriesNumber: base?.seriesNumber ?? null,
            baseSeriesDescription: base?.seriesDescription ?? null,
            baseDescriptionsDiffer: baseDescriptions.size > 1,
            seriesNumber: computeSeriesNumber(cs.attributes, base?.seriesNumber),
            seriesDescription: computeDescription(cs.attributes, base?.seriesDescription),
            seriesInstanceUID: null // assigned at export time
        });
    }

    // Two output series sharing a number confuses every viewer, so flag it.
    const numberOwners = new Map();
    for (const cs of resolved) {
        if (cs.seriesNumber === null || !cs.fileCount) continue;
        if (!numberOwners.has(cs.seriesNumber)) numberOwners.set(cs.seriesNumber, []);
        numberOwners.get(cs.seriesNumber).push(cs.label);
    }
    for (const [number, owners] of numberOwners) {
        if (owners.length > 1) {
            conflicts.push({
                level: "warning",
                childSeriesId: null,
                message: `Series number ${number} is used by ${owners.join(" and ")}.`
            });
        }
    }

    for (const [filePath, owners] of claimsByPath) {
        if (owners.length > 1) {
            conflicts.push({
                level: "info",
                childSeriesId: null,
                filePath,
                message: `${filePath.split("/").pop()} is claimed by ${owners.length} child series; each copy after the first gets a new SOPInstanceUID.`
            });
        }
    }

    const unclaimed = new Set();
    for (const v of analysis.volumes) {
        for (const row of v.grid) for (const r of row) if (!claimsByPath.has(r.filePath)) unclaimed.add(r.filePath);
    }

    return {
        childSeries: resolved,
        claimsByPath,
        unclaimedPaths: [...unclaimed],
        conflicts
    };
}

module.exports = {
    RULESET_VERSION,
    PALETTE,
    paletteColor,
    parseRange,
    formatRange,
    defaultAttributes,
    makeChildSeries,
    emptyRuleSet,
    normalizeRuleSet,
    fingerprintVolumes,
    checkRuleSetFit,
    computeSeriesNumber,
    computeDescription,
    stripPrefix,
    resolveRuleSet
};
