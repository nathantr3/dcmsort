import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

import scanner from "../src/main/scanner.js";
import analyze from "../src/main/analyze.js";

const { scanDirectory } = scanner;
const { analyzeSeries } = analyze;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "data");

let bySeriesNumber;

beforeAll(async () => {
    const { records } = await scanDirectory(FIXTURES);
    bySeriesNumber = new Map();
    for (const r of records) {
        const key = `${r.patientID}/${r.seriesNumber}`;
        if (!bySeriesNumber.has(key)) bySeriesNumber.set(key, []);
        bySeriesNumber.get(key).push(r);
    }
});

const series = (key) => analyzeSeries(bySeriesNumber.get(key));

/** Total cells in the grid must equal the number of files in the volume. */
function expectWellFormedGrid(volume) {
    expect(volume.grid.length).toBe(volume.slices);
    for (const row of volume.grid) expect(row.length).toBe(volume.phases);
    expect(volume.slices * volume.phases).toBe(volume.fileCount);

    const uids = volume.grid.flat().map((r) => r.sopInstanceUID);
    expect(new Set(uids).size).toBe(uids.length);
}

describe("analyzeSeries", () => {
    it("detects a clean slices x phases matrix", () => {
        const a = series("P001/3");
        expect(a.cohortCount).toBe(1);
        expect(a.volumes).toHaveLength(1);
        expect(a.volumes[0]).toMatchObject({
            slices: 8,
            phases: 4,
            sliceKeySource: "ImagePositionPatient",
            phaseKey: "TemporalPositionIdentifier",
            phaseKeyConfident: true
        });
        expectWellFormedGrid(a.volumes[0]);
        expect(a.warnings).toHaveLength(0);
    });

    it("separates co-located cohorts that differ only by reconstruction", () => {
        // The case dcmsplit could not express: three stacks at identical slice
        // positions with 4, 2, and 1 phases, distinguished only by ImageType.
        const a = series("P001/4");
        expect(a.cohortCount).toBe(3);
        expect(a.volumes.map((v) => [v.slices, v.phases])).toEqual([
            [8, 4],
            [8, 2],
            [8, 1]
        ]);
        a.volumes.forEach(expectWellFormedGrid);

        const imageTypes = a.volumes.map(
            (v) => v.distinguishers.find((d) => d.field === "imageType")?.value
        );
        expect(imageTypes).toEqual([
            "ORIGINAL\\PRIMARY\\M\\FFE",
            "ORIGINAL\\PRIMARY\\P\\FFE",
            "DERIVED\\PRIMARY\\PDFF\\FFE"
        ]);
    });

    it("splits a ragged cohort into one volume per repeat count and warns", () => {
        const a = series("P001/5");
        expect(a.cohortCount).toBe(1);
        expect(a.volumes.map((v) => [v.slices, v.phases])).toEqual([
            [4, 3],
            [4, 2]
        ]);
        a.volumes.forEach(expectWellFormedGrid);
        expect(a.warnings.join(" ")).toMatch(/did not fit a single \(x, y, z, p\) matrix/);
    });

    it("falls back to TriggerTime when TemporalPositionIdentifier is absent", () => {
        const a = series("P002/2");
        expect(a.volumes[0]).toMatchObject({ slices: 6, phases: 3, phaseKey: "TriggerTime", phaseKeyConfident: true });
        expectWellFormedGrid(a.volumes[0]);
    });

    it("falls back to SliceLocation and InstanceNumber with no geometry or temporal tags", () => {
        const a = series("P002/7");
        const v = a.volumes[0];
        expect(v).toMatchObject({
            slices: 5,
            phases: 2,
            sliceKeySource: "SliceLocation",
            phaseKey: "InstanceNumber",
            phaseKeyConfident: false
        });
        expectWellFormedGrid(v);
        expect(a.warnings.join(" ")).toMatch(/fell back to InstanceNumber/);
    });

    it("reports a single-phase anatomical stack as P = 1", () => {
        const a = series("P002/1");
        expect(a.volumes).toHaveLength(1);
        expect(a.volumes[0]).toMatchObject({ slices: 10, phases: 1 });
    });

    it("orders phases by the chosen key, not by file order", () => {
        // Series 7 is written phase-major, so a naive read would interleave.
        const v = series("P002/7").volumes[0];
        for (const row of v.grid) {
            const instances = row.map((r) => r.instanceNumber);
            expect([...instances].sort((a, b) => a - b)).toEqual(instances);
        }
    });

    it("honours a phase key override", () => {
        const recs = bySeriesNumber.get("P001/3");
        const a = analyzeSeries(recs, { phaseKeyOverrides: { v1: "InstanceNumber" } });
        expect(a.volumes[0].phaseKey).toBe("InstanceNumber");
        expect(a.volumes[0].phaseKeyCandidates.map((c) => c.id)).toContain("TemporalPositionIdentifier");
    });

    it("numbers volumes deterministically regardless of input order", () => {
        // Volume ids are positional and get baked into saved rule sets, so a
        // reshuffled scan must still produce v1 = the 4-phase magnitude stack.
        const recs = bySeriesNumber.get("P001/4");
        const shuffled = [...recs].reverse();
        const a = analyzeSeries(recs).volumes.map((v) => [v.id, v.slices, v.phases]);
        const b = analyzeSeries(shuffled).volumes.map((v) => [v.id, v.slices, v.phases]);
        expect(b).toEqual(a);
        expect(a[0]).toEqual(["v1", 8, 4]);
    });

    it("returns a warning rather than throwing on an empty series", () => {
        expect(analyzeSeries([])).toEqual({ volumes: [], warnings: ["Series contains no files"] });
    });
});
