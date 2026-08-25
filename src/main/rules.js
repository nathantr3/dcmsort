"use strict";

/**
 * The rule engine: turn a saved rule set into a concrete plan of which files
 * land in which output series, carrying which attributes.
 *
 * A rule set is the document the GUI edits and `saveRuleSet` persists. Each
 * child series is one output series, defined by selections that read as
 * "FROM volume 1 SELECT slices * AND phases 1-3", plus the attribute edits to
 * apply to whatever those selections match.
 *
 * Selections bind to volumes positionally, by id, and to nothing else. A saved
 * rule set therefore records nothing about where it came from - no series UID,
 * number or description - only a `requirements` block describing the shape it
 * needs, so it can be re-run against any data of that shape.
 */

const fsp = require("fs/promises");
const path = require("path");

const RULESET_VERSION = 1;

/**
 * A rule set usually belongs to one folder of DICOMs, so we look for one there
 * on every scan. `rules.dcmsort.json` is what the save dialog offers, and it
 * wins outright; otherwise a lone `*.dcmsort.json` is unambiguous enough to
 * take. Several of those and no default name is a choice we cannot make for
 * the user.
 */
const RULE_FILE_NAME = "rules.dcmsort.json";
const RULE_FILE_SUFFIX = ".dcmsort.json";

/**
 * @param {string} root folder to look in, top level only
 * @returns {Promise<{filePath: string} | {ambiguous: string[]} | null>}
 */
async function findRuleFile(root) {
    let entries;
    try {
        entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
        return null;
    }

    const names = entries.filter((e) => e.isFile() && e.name.endsWith(RULE_FILE_SUFFIX)).map((e) => e.name);
    if (names.includes(RULE_FILE_NAME)) return { filePath: path.join(root, RULE_FILE_NAME) };
    if (names.length === 1) return { filePath: path.join(root, names[0]) };
    if (names.length > 1) return { ambiguous: names.sort() };
    return null;
}

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

function emptyRuleSet() {
    return { version: RULESET_VERSION, childSeries: [] };
}

/* ------------------------------------------------------------------ */
/* Shape requirements                                                  */
/* ------------------------------------------------------------------ */

/**
 * What one axis of one volume has to look like for a rule set to fit.
 *
 * Only the axes a rule actually indexes can matter. Selecting slices `*` says
 * nothing about how many slices there should be, so a rule written that way
 * applies to a 30-slice volume and a 300-slice one alike. An axis that is
 * indexed by position is pinned to the extent it was written against, which
 * keeps the invariant that a rule always fits the data it was built on - a
 * "phases 1-2" rule off a 4-phase volume needs 4 phases, not 2.
 *
 * The relative and open-ended forms exist to adapt to size, so they set a
 * floor rather than a fixed extent: `-1` is the last item whatever the size,
 * and `3-` runs to the end.
 *
 * @param {string[]} specs every spec used for this axis on this volume
 * @param {number} sourceExtent the axis size in the analysis being saved
 * @returns {{exact: number} | {min: number} | null} null when unconstrained
 */
function axisRequirement(specs, sourceExtent) {
    let pinned = false;
    let floor = 0;

    for (const spec of specs) {
        const text = String(spec ?? "").trim();
        if (text === "" || text === "*") continue;

        for (const rawTerm of text.split(",")) {
            const term = rawTerm.trim();
            if (!term) continue;

            const single = term.match(SINGLE_RE);
            if (single) {
                const n = Number(single[1]);
                if (n < 0) floor = Math.max(floor, -n); // counted from the end
                else pinned = true;
                continue;
            }

            const range = term.match(RANGE_RE);
            // An unparseable term is a broken rule; resolution reports it far
            // better than a requirement could, so claim nothing here.
            if (!range) continue;

            // A range that runs to the end adapts to the axis size, so even an
            // absolute start only sets a floor. Only a range bounded at both
            // ends pins the axis.
            const openEnd = range[2] === undefined;
            const bounds = openEnd ? [range[1] ?? "1"] : [range[1] ?? "1", range[2]];

            for (const bound of bounds) {
                const n = Number(bound);
                if (n < 0) floor = Math.max(floor, -n);
                else if (openEnd) floor = Math.max(floor, n);
                else pinned = true;
            }
        }
    }

    if (pinned) return { exact: sourceExtent };
    // A floor of one is satisfied by any volume that exists at all, so it is
    // not worth recording.
    return floor > 1 ? { min: floor } : null;
}

/**
 * The shape a rule set needs, derived from the analysis it was built on and
 * narrowed to the axes its selections actually index. This is the whole of
 * what a saved rule file carries about its origin.
 */
function describeRequirements(ruleSet, analysis) {
    if (!analysis) return null;

    const volumesById = new Map(analysis.volumes.map((v) => [v.id, v]));
    const selectionsByVolume = new Map();

    for (const cs of ruleSet?.childSeries || []) {
        for (const selection of cs.selections || []) {
            if (!selectionsByVolume.has(selection.volumeId)) selectionsByVolume.set(selection.volumeId, []);
            selectionsByVolume.get(selection.volumeId).push(selection);
        }
    }

    const volumes = {};
    for (const [volumeId, selections] of selectionsByVolume) {
        const volume = volumesById.get(volumeId);
        if (!volume) continue;

        const needs = {};
        const slices = axisRequirement(selections.map((sel) => sel.slices), volume.slices);
        const phases = axisRequirement(selections.map((sel) => sel.phases), volume.phases);
        if (slices) needs.slices = slices;
        if (phases) needs.phases = phases;
        if (Object.keys(needs).length) volumes[volumeId] = needs;
    }

    return { volumeCount: analysis.volumes.length, volumes };
}

/**
 * Does a rule set fit an analysis? Every problem is an error: either the shape
 * matches or the rules are not for this data.
 *
 * A rule set with no requirements - one still being built against a live
 * analysis, or hand-written - is not checked.
 */
function checkRuleSetFit(ruleSet, analysis) {
    const requirements = ruleSet?.requirements;
    if (!requirements) return [];

    const problems = [];
    const volumeCount = analysis.volumes.length;

    if (Number.isFinite(requirements.volumeCount) && requirements.volumeCount !== volumeCount) {
        problems.push({
            level: "error",
            message: `these rules were built on ${pluralizeVolumes(requirements.volumeCount)}; this selection has ${volumeCount}.`
        });
    }

    const volumesById = new Map(analysis.volumes.map((v) => [v.id, v]));

    for (const [volumeId, needs] of Object.entries(requirements.volumes || {})) {
        const volume = volumesById.get(volumeId);
        if (!volume) {
            problems.push({ level: "error", volumeId, message: `${volumeId} does not exist in the current selection.` });
            continue;
        }

        for (const axis of ["slices", "phases"]) {
            const need = needs[axis];
            if (!need) continue;
            const actual = volume[axis];

            if (Number.isFinite(need.exact) && actual !== need.exact) {
                problems.push({
                    level: "error",
                    volumeId,
                    message: `${volumeId} needs exactly ${need.exact} ${axis}; this volume has ${actual}.`
                });
            } else if (Number.isFinite(need.min) && actual < need.min) {
                problems.push({
                    level: "error",
                    volumeId,
                    message: `${volumeId} needs at least ${need.min} ${axis}; this volume has ${actual}.`
                });
            }
        }
    }

    return problems;
}

function pluralizeVolumes(n) {
    return `${n} volume${n === 1 ? "" : "s"}`;
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
        // The shape these rules need, and the whole of what a rule file says
        // about where it came from. A set still being built in the app has
        // none until it is saved against an analysis.
        requirements: ruleSet?.requirements || null,
        // volumeId -> DICOM keyword, the shape analyzeSelection takes. Kept in
        // the file because the phase ordering decides what "phases 1-3" means;
        // re-detecting it elsewhere could quietly select different images.
        phaseKeyOverrides: ruleSet?.phaseKeyOverrides || {},
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
    RULE_FILE_NAME,
    RULE_FILE_SUFFIX,
    findRuleFile,
    PALETTE,
    paletteColor,
    parseRange,
    formatRange,
    defaultAttributes,
    makeChildSeries,
    emptyRuleSet,
    normalizeRuleSet,
    axisRequirement,
    describeRequirements,
    checkRuleSetFit,
    computeSeriesNumber,
    computeDescription,
    stripPrefix,
    resolveRuleSet
};
