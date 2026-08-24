import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

import scanner from "../src/main/scanner.js";
import analyze from "../src/main/analyze.js";
import rules from "../src/main/rules.js";

const { scanDirectory } = scanner;
const { analyzeSelection } = analyze;
const {
    fingerprintVolumes,
    checkRuleSetFit,
    normalizeRuleSet,
    parseRange,
    formatRange,
    computeSeriesNumber,
    computeDescription,
    stripPrefix,
    defaultAttributes,
    resolveRuleSet,
    emptyRuleSet
} = rules;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "data");

let analysis;

beforeAll(async () => {
    const { records } = await scanDirectory(FIXTURES);
    // Series 4 of study A: the 8x4 / 8x2 / 8x1 co-located stacks.
    const target = records.filter((r) => r.patientID === "P001" && r.seriesNumber === 4);
    analysis = analyzeSelection([{ seriesInstanceUID: target[0].seriesInstanceUID, records: target }]);
});

describe("parseRange", () => {
    it("expands the wildcard and empty input to the whole axis", () => {
        expect(parseRange("*", 4)).toEqual([1, 2, 3, 4]);
        expect(parseRange("", 3)).toEqual([1, 2, 3]);
        expect(parseRange(null, 2)).toEqual([1, 2]);
    });

    it("parses singles, lists, ranges, open ranges and strides", () => {
        expect(parseRange("2", 5)).toEqual([2]);
        expect(parseRange("1,3,5", 5)).toEqual([1, 3, 5]);
        expect(parseRange("2-4", 5)).toEqual([2, 3, 4]);
        expect(parseRange("3-", 5)).toEqual([3, 4, 5]);
        expect(parseRange("-4", 5)).toEqual([2]); // fourth from the end
        expect(parseRange("1-9:2", 9)).toEqual([1, 3, 5, 7, 9]);
        expect(parseRange("1-3,7-", 8)).toEqual([1, 2, 3, 7, 8]);
    });

    it("treats a leading minus as counting from the end", () => {
        expect(parseRange("-1", 9)).toEqual([9]);
        expect(parseRange("-3--1", 9)).toEqual([7, 8, 9]);
    });

    it("de-duplicates and sorts overlapping terms", () => {
        expect(parseRange("3,1-4,2", 5)).toEqual([1, 2, 3, 4]);
    });

    it("descends when the range runs backwards but still returns sorted output", () => {
        expect(parseRange("4-2", 5)).toEqual([2, 3, 4]);
    });

    it("rejects out-of-bounds and unparseable input", () => {
        expect(() => parseRange("9", 4)).toThrow(/outside 1\.\.4/);
        expect(() => parseRange("0", 4)).toThrow(/outside/);
        expect(() => parseRange("abc", 4)).toThrow(/cannot parse/);
        expect(() => parseRange("1-4:0", 4)).toThrow(/stride/);
    });

    it("returns nothing for a zero-length axis", () => {
        expect(parseRange("*", 0)).toEqual([]);
    });

    it("formatRange round-trips the compact form", () => {
        expect(formatRange(parseRange("*", 4), 4)).toBe("*");
        expect(formatRange(parseRange("1-3", 9), 9)).toBe("1-3");
        expect(formatRange(parseRange("1,3,5", 9), 9)).toBe("1,3,5");
        expect(formatRange([], 9)).toBe("(none)");
    });
});

describe("attribute formulas", () => {
    it("applies dcmsplit's scale/offset series number formula", () => {
        const attrs = { ...defaultAttributes(), seriesScale: 100, seriesOffset: 1 };
        expect(computeSeriesNumber(attrs, 3)).toBe(301);
        expect(computeSeriesNumber({ ...attrs, seriesOffset: 2 }, 3)).toBe(302);
        expect(computeSeriesNumber({ ...attrs, seriesScale: 1, seriesOffset: 1000 }, 3)).toBe(1003);
    });

    it("supports an absolute series number override", () => {
        const attrs = { ...defaultAttributes(), seriesNumberMode: "absolute", seriesNumberAbsolute: 777 };
        expect(computeSeriesNumber(attrs, 3)).toBe(777);
    });

    it("treats a missing base series number as zero", () => {
        expect(computeSeriesNumber({ ...defaultAttributes(), seriesScale: 100, seriesOffset: 5 }, null)).toBe(5);
    });

    it("strips an existing prefix case-insensitively, colon and all", () => {
        expect(stripPrefix("NOT DIAGNOSTIC: T1 VIBE", "NOT DIAGNOSTIC:")).toBe("T1 VIBE");
        expect(stripPrefix("not diagnostic: T1 VIBE", "NOT DIAGNOSTIC:")).toBe("T1 VIBE");
        expect(stripPrefix("T1 VIBE", "NOT DIAGNOSTIC:")).toBe("T1 VIBE");
    });

    it("builds descriptions in affix mode", () => {
        const attrs = { ...defaultAttributes(), descriptionPrefix: "NOT DIAGNOSTIC:", descriptionNew: "Early" };
        expect(computeDescription(attrs, "T1 VIBE")).toBe("NOT DIAGNOSTIC: Early: T1 VIBE");
        expect(computeDescription({ ...attrs, descriptionNew: null }, "T1 VIBE")).toBe("NOT DIAGNOSTIC: T1 VIBE");
        expect(computeDescription({ ...defaultAttributes(), descriptionSuffix: "(1-3)" }, "T1 VIBE")).toBe("T1 VIBE (1-3)");
    });

    it("replaces the description outright in replace mode", () => {
        const attrs = { ...defaultAttributes(), descriptionMode: "replace", descriptionNew: "PHASES 1-3" };
        expect(computeDescription(attrs, "T1 VIBE")).toBe("PHASES 1-3");
    });

    it("does not stack a prefix when re-applied to an already-prefixed description", () => {
        const attrs = { ...defaultAttributes(), descriptionPrefix: "NOT DIAGNOSTIC:", stripExistingPrefix: true };
        expect(computeDescription(attrs, "NOT DIAGNOSTIC: T1 VIBE")).toBe("NOT DIAGNOSTIC: T1 VIBE");
    });

    it("strips one prefix and adds a different one", () => {
        const attrs = {
            ...defaultAttributes(),
            descriptionStripPrefix: "NOT DIAGNOSTIC:",
            descriptionPrefix: "My Feature:"
        };
        expect(computeDescription(attrs, "NOT DIAGNOSTIC: T1 VIBE")).toBe("My Feature: T1 VIBE");
        // Nothing to strip is not an error; the prefix is still added.
        expect(computeDescription(attrs, "T1 VIBE")).toBe("My Feature: T1 VIBE");
    });

    it("strips a prefix without adding one", () => {
        const attrs = { ...defaultAttributes(), descriptionStripPrefix: "NOT DIAGNOSTIC:" };
        expect(computeDescription(attrs, "NOT DIAGNOSTIC: T1 VIBE")).toBe("T1 VIBE");
    });

    it("matches the stripped prefix case-insensitively and eats a trailing colon", () => {
        const attrs = { ...defaultAttributes(), descriptionStripPrefix: "not diagnostic" };
        expect(computeDescription(attrs, "NOT DIAGNOSTIC: T1 VIBE")).toBe("T1 VIBE");
    });

    it("applies the stripped prefix and the added prefix independently", () => {
        // Both mechanisms at once: drop the old marker, add a new one, and do
        // not let the new one stack on a re-export.
        const attrs = {
            ...defaultAttributes(),
            descriptionStripPrefix: "NOT DIAGNOSTIC:",
            descriptionPrefix: "My Feature:",
            stripExistingPrefix: true
        };
        expect(computeDescription(attrs, "NOT DIAGNOSTIC: My Feature: T1 VIBE")).toBe("My Feature: T1 VIBE");
    });

    it("strips before applying a label in affix mode", () => {
        const attrs = {
            ...defaultAttributes(),
            descriptionStripPrefix: "NOT DIAGNOSTIC:",
            descriptionNew: "Early",
            descriptionPrefix: "My Feature:"
        };
        expect(computeDescription(attrs, "NOT DIAGNOSTIC: T1 VIBE")).toBe("My Feature: Early: T1 VIBE");
    });

    it("leaves the stripped prefix irrelevant in replace mode", () => {
        const attrs = {
            ...defaultAttributes(),
            descriptionMode: "replace",
            descriptionStripPrefix: "NOT DIAGNOSTIC:",
            descriptionNew: "PDFF"
        };
        expect(computeDescription(attrs, "NOT DIAGNOSTIC: T1 VIBE")).toBe("PDFF");
    });

    it("truncates to the 64-character LO limit", () => {
        const attrs = { ...defaultAttributes(), descriptionMode: "replace", descriptionNew: "X".repeat(100) };
        expect(computeDescription(attrs, "").length).toBe(64);
    });
});

describe("resolveRuleSet", () => {
    const childSeries = (overrides) => ({
        id: "cs-1",
        label: "Early phases",
        color: "#4EC9B0",
        selections: [{ volumeId: "v1", slices: "*", phases: "1-3" }],
        attributes: defaultAttributes(),
        ...overrides
    });

    it("resolves a selection to the right cells of the grid", () => {
        const result = resolveRuleSet({ ...emptyRuleSet(), childSeries: [childSeries()] }, analysis);
        const cs = result.childSeries[0];
        expect(cs.fileCount).toBe(8 * 3); // 8 slices x phases 1-3
        expect(new Set(cs.cells.map((c) => c.phaseIndex))).toEqual(new Set([1, 2, 3]));
        expect(cs.seriesNumber).toBe(401); // 100 * 4 + 1
        expect(result.conflicts.filter((c) => c.level === "error")).toHaveLength(0);
    });

    it("numbers instances phase-major by default and slice-major on request", () => {
        const phaseMajor = resolveRuleSet({ ...emptyRuleSet(), childSeries: [childSeries()] }, analysis)
            .childSeries[0].cells;
        expect(phaseMajor.slice(0, 8).every((c) => c.phaseIndex === 1)).toBe(true);
        expect(phaseMajor.map((c) => c.outputInstanceNumber)).toEqual(
            Array.from({ length: 24 }, (_, i) => i + 1)
        );

        const sliceMajor = resolveRuleSet(
            {
                ...emptyRuleSet(),
                childSeries: [
                    childSeries({ attributes: { ...defaultAttributes(), instanceOrder: "slice-major" } })
                ]
            },
            analysis
        ).childSeries[0].cells;
        expect(sliceMajor.slice(0, 3).every((c) => c.sliceIndex === 1)).toBe(true);
    });

    it("reports how many files each selection contributed", () => {
        const cs = childSeries({
            selections: [
                { volumeId: "v1", slices: "*", phases: "1" },
                { volumeId: "v1", slices: "*", phases: "1-2" }, // phase 1 already taken
                { volumeId: "v99", slices: "*", phases: "*" } // unresolvable
            ]
        });
        const result = resolveRuleSet({ ...emptyRuleSet(), childSeries: [cs] }, analysis);
        expect(result.childSeries[0].selectionCounts).toEqual([8, 8, 0]);
        expect(result.childSeries[0].fileCount).toBe(16);
    });

    it("joins selections across volumes into one child series", () => {
        const cs = childSeries({
            selections: [
                { volumeId: "v1", slices: "*", phases: "1" },
                { volumeId: "v3", slices: "*", phases: "*" }
            ]
        });
        const result = resolveRuleSet({ ...emptyRuleSet(), childSeries: [cs] }, analysis);
        expect(result.childSeries[0].fileCount).toBe(8 + 8);
    });

    it("flags a file claimed by two child series without failing", () => {
        const ruleSet = {
            ...emptyRuleSet(),
            childSeries: [
                childSeries({ id: "cs-1", label: "A", selections: [{ volumeId: "v1", slices: "*", phases: "1-2" }] }),
                childSeries({ id: "cs-2", label: "B", selections: [{ volumeId: "v1", slices: "*", phases: "2-3" }] })
            ]
        };
        const result = resolveRuleSet(ruleSet, analysis);
        const overlaps = result.conflicts.filter((c) => c.level === "info");
        expect(overlaps).toHaveLength(8); // the 8 slices of phase 2
        expect(result.conflicts.filter((c) => c.level === "error")).toHaveLength(0);
    });

    it("warns about duplicate output series numbers", () => {
        const ruleSet = {
            ...emptyRuleSet(),
            childSeries: [
                childSeries({ id: "cs-1", label: "A" }),
                childSeries({ id: "cs-2", label: "B", selections: [{ volumeId: "v1", slices: "*", phases: "4" }] })
            ]
        };
        const result = resolveRuleSet(ruleSet, analysis);
        expect(result.conflicts.some((c) => /Series number 401 is used by A and B/.test(c.message))).toBe(true);
    });

    it("reports errors for unknown volumes and bad ranges but keeps going", () => {
        const ruleSet = {
            ...emptyRuleSet(),
            childSeries: [
                childSeries({
                    selections: [
                        { volumeId: "v99", slices: "*", phases: "*" },
                        { volumeId: "v1", slices: "*", phases: "99" },
                        { volumeId: "v1", slices: "1-2", phases: "1" }
                    ]
                })
            ]
        };
        const result = resolveRuleSet(ruleSet, analysis);
        expect(result.conflicts.filter((c) => c.level === "error")).toHaveLength(2);
        expect(result.childSeries[0].fileCount).toBe(2); // the valid selection still resolves
    });

    it("warns when a child series matches nothing", () => {
        const result = resolveRuleSet(
            { ...emptyRuleSet(), childSeries: [childSeries({ selections: [] })] },
            analysis
        );
        expect(result.conflicts.some((c) => /matches no files/.test(c.message))).toBe(true);
    });

    it("tracks which files no rule claims", () => {
        const result = resolveRuleSet({ ...emptyRuleSet(), childSeries: [childSeries()] }, analysis);
        // 56 files in the series, 24 claimed.
        expect(result.unclaimedPaths).toHaveLength(56 - 24);
        expect(result.claimsByPath.size).toBe(24);
    });
});

describe("rule set portability", () => {
    const ruleSet = {
        ...emptyRuleSet(),
        childSeries: [
            { id: "cs-1", label: "A", selections: [{ volumeId: "v1", slices: "*", phases: "1-3" }] }
        ]
    };

    it("fingerprints each volume by shape and source series", () => {
        expect(fingerprintVolumes(analysis)).toEqual({ v1: "8x4@4", v2: "8x2@4", v3: "8x1@4" });
    });

    it("passes a rule set saved against the same data", () => {
        const saved = { ...ruleSet, volumeFingerprints: fingerprintVolumes(analysis) };
        expect(checkRuleSetFit(saved, analysis)).toEqual([]);
    });

    it("warns when a volume changed shape since the rules were saved", () => {
        const saved = { ...ruleSet, volumeFingerprints: { v1: "8x9@4" } };
        const problems = checkRuleSetFit(saved, analysis);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({ level: "warning", volumeId: "v1" });
        expect(problems[0].message).toMatch(/was 8x9@4 .* but is 8x4@4 now/);
    });

    it("errors when a referenced volume is gone entirely", () => {
        const saved = {
            ...emptyRuleSet(),
            childSeries: [{ id: "cs-1", label: "A", selections: [{ volumeId: "v9", slices: "*", phases: "*" }] }]
        };
        expect(checkRuleSetFit(saved, analysis)).toEqual([
            { level: "error", volumeId: "v9", message: "v9 does not exist in the current selection." }
        ]);
    });

    it("fills in defaults for a hand-edited rule file", () => {
        const sparse = { childSeries: [{ selections: [{ volumeId: "v1" }] }] };
        const normalized = normalizeRuleSet(sparse);
        expect(normalized.version).toBe(1);
        expect(normalized.childSeries[0]).toMatchObject({ id: "cs-1", color: "#4EC9B0" });
        expect(normalized.childSeries[0].selections[0]).toEqual({ volumeId: "v1", slices: "*", phases: "*" });
        expect(normalized.childSeries[0].attributes.seriesScale).toBe(100);
    });

    it("loads a rule file written before descriptionStripPrefix existed", () => {
        const old = {
            version: 1,
            childSeries: [
                {
                    id: "cs-1",
                    label: "A",
                    selections: [{ volumeId: "v1", slices: "*", phases: "1-3" }],
                    attributes: { descriptionPrefix: "NOT DIAGNOSTIC:", stripExistingPrefix: true }
                }
            ]
        };
        const attrs = normalizeRuleSet(old).childSeries[0].attributes;
        expect(attrs.descriptionStripPrefix).toBeNull();
        // The old behaviour is unchanged by the new field being absent.
        expect(computeDescription(attrs, "NOT DIAGNOSTIC: T1 VIBE")).toBe("NOT DIAGNOSTIC: T1 VIBE");
    });
});
