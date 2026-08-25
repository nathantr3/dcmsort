import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import scanner from "../src/main/scanner.js";
import analyze from "../src/main/analyze.js";
import rules from "../src/main/rules.js";
import exporter from "../src/main/export.js";
import io from "../src/main/dicom-io.js";
import tags from "../src/main/tags.js";

const { scanDirectory } = scanner;
const { analyzeSelection } = analyze;
const { resolveRuleSet, emptyRuleSet, defaultAttributes } = rules;
const { exportPlan, sanitize } = exporter;
const { T } = tags;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "data");

let analysis;
let tmpRoot;

beforeAll(async () => {
    const { records } = await scanDirectory(FIXTURES);
    const target = records.filter((r) => r.patientID === "P001" && r.seriesNumber === 4);
    analysis = analyzeSelection([{ seriesInstanceUID: target[0].seriesInstanceUID, records: target }]);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcmsort-export-"));
});
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function makeRuleSet(childSeries) {
    return { ...emptyRuleSet(), childSeries };
}

/**
 * Copy a fixture series to a scratch directory, images only.
 *
 * A plain recursive copy also drags along whatever the operating system has
 * left in the fixture folder - .DS_Store above all - which then counts as a
 * file in the work directory and fails assertions about what is there.
 */
function copyImages(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
        if (!name.endsWith(".dcm")) continue;
        fs.copyFileSync(path.join(from, name), path.join(to, name));
    }
}

const child = (overrides) => ({
    id: "cs-1",
    label: "Early phases",
    color: "#4EC9B0",
    selections: [{ volumeId: "v1", slices: "*", phases: "1-3" }],
    attributes: { ...defaultAttributes(), descriptionNew: "Early" },
    ...overrides
});

async function readTags(file) {
    const dict = await io.readFull(file);
    return {
        seriesUID: io.getStr(dict.dict, T.SeriesInstanceUID),
        seriesNumber: io.getNum(dict.dict, T.SeriesNumber),
        seriesDescription: io.getStr(dict.dict, T.SeriesDescription),
        instanceNumber: io.getNum(dict.dict, T.InstanceNumber),
        sopUID: io.getStr(dict.dict, T.SOPInstanceUID),
        metaSopUID: io.getStr(dict.meta, T.MediaStorageSOPInstanceUID)
    };
}

describe("exportPlan to a new folder", () => {
    let out;
    let result;
    let files;

    beforeAll(async () => {
        out = path.join(tmpRoot, "newfolder");
        const plan = resolveRuleSet(makeRuleSet([child()]), analysis);
        result = await exportPlan(plan, { mode: "new-folder", outputDir: out });
        files = result.written.map((w) => w.outPath).sort();
    });

    it("writes every selected file and nothing else", () => {
        expect(result.stats).toMatchObject({ totalFiles: 24, writtenCount: 24, errorCount: 0 });
        const onDisk = fs.readdirSync(path.dirname(files[0]));
        expect(onDisk).toHaveLength(24);
    });

    it("lays files out as study / series / IM-NNNNN.dcm", () => {
        const rel = path.relative(out, files[0]).split(path.sep);
        expect(rel).toHaveLength(3);
        expect(rel[0]).toBe("CARDIAC_MR");
        expect(rel[1]).toBe("401_Early__MULTI_RECON");
        expect(rel[2]).toMatch(/^IM-\d{5}\.dcm$/);
    });

    it("stamps the computed series number, description and a fresh series UID", async () => {
        const t = await readTags(files[0]);
        expect(t.seriesNumber).toBe(401);
        expect(t.seriesDescription).toBe("Early: MULTI RECON");
        expect(t.seriesUID).toBe(result.seriesUIDs["cs-1"]);
        expect(t.seriesUID).toMatch(/^2\.25\.\d+$/);
    });

    it("gives every output file the same new series UID", async () => {
        const uids = new Set();
        for (const f of files) uids.add((await readTags(f)).seriesUID);
        expect(uids.size).toBe(1);
    });

    it("renumbers instances 1..N with no gaps", async () => {
        const numbers = [];
        for (const f of files) numbers.push((await readTags(f)).instanceNumber);
        expect(numbers.sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    });

    it("keeps the original SOPInstanceUID and syncs the file meta copy", async () => {
        const t = await readTags(files[0]);
        expect(t.sopUID).toMatch(/^1\.2\.826\./); // unchanged fixture UID
        expect(t.metaSopUID).toBe(t.sopUID);
    });

    it("leaves the source files untouched", async () => {
        const source = analysis.volumes[0].grid[0][0].filePath;
        const t = await readTags(source);
        expect(t.seriesNumber).toBe(4);
        expect(t.seriesDescription).toBe("MULTI RECON");
    });

    it("reports progress up to the total", async () => {
        const seen = [];
        const plan = resolveRuleSet(makeRuleSet([child()]), analysis);
        await exportPlan(plan, { mode: "new-folder", outputDir: path.join(tmpRoot, "progress") }, {
            onProgress: (p) => seen.push(p)
        });
        expect(seen).toHaveLength(24);
        expect(seen.at(-1)).toMatchObject({ processed: 24, totalFiles: 24, errorCount: 0 });
    });
});

describe("exportPlan with overlapping child series", () => {
    it("gives the second claim of a file a new SOPInstanceUID", async () => {
        const plan = resolveRuleSet(
            makeRuleSet([
                child({ id: "cs-1", label: "A", selections: [{ volumeId: "v1", slices: "1", phases: "1-2" }] }),
                child({ id: "cs-2", label: "B", selections: [{ volumeId: "v1", slices: "1", phases: "2-3" }] })
            ]),
            analysis
        );
        const result = await exportPlan(plan, { mode: "new-folder", outputDir: path.join(tmpRoot, "overlap") });
        expect(result.stats.errorCount).toBe(0);

        const byChild = (id) => result.written.filter((w) => w.childSeriesId === id);
        const shared = byChild("cs-1").find((w) => byChild("cs-2").some((o) => o.source === w.source));
        expect(shared).toBeTruthy();

        const first = await readTags(shared.outPath);
        const second = await readTags(byChild("cs-2").find((w) => w.source === shared.source).outPath);

        expect(second.sopUID).not.toBe(first.sopUID);
        expect(second.sopUID).toMatch(/^2\.25\.\d+$/);
        expect(second.metaSopUID).toBe(second.sopUID);
        expect(second.seriesUID).not.toBe(first.seriesUID);
    });
});

describe("exportPlan in place", () => {
    it("rewrites the source files and parks extra claims alongside them", async () => {
        // Work on a throwaway copy: in-place export overwrites what it reads.
        const workDir = path.join(tmpRoot, "inplace");
        copyImages(path.join(FIXTURES, "studyA", "series3"), workDir);

        const { records } = await scanDirectory(workDir);
        const localAnalysis = analyzeSelection([
            { seriesInstanceUID: records[0].seriesInstanceUID, records }
        ]);
        const plan = resolveRuleSet(
            makeRuleSet([
                child({ id: "cs-1", label: "A", selections: [{ volumeId: "v1", slices: "*", phases: "1" }] }),
                child({ id: "cs-2", label: "B", selections: [{ volumeId: "v1", slices: "*", phases: "1" }] })
            ]),
            localAnalysis
        );
        const result = await exportPlan(plan, { mode: "in-place" });

        expect(result.stats.errorCount).toBe(0);
        const first = result.written.filter((w) => w.childSeriesId === "cs-1");
        expect(first.every((w) => w.outPath === w.source)).toBe(true);

        const second = result.written.filter((w) => w.childSeriesId === "cs-2");
        expect(second.every((w) => w.outPath.includes("_cs-2"))).toBe(true);
        expect(second.every((w) => fs.existsSync(w.outPath))).toBe(true);

        // Files the rules did not claim are left exactly as they were.
        const sources = fs.readdirSync(workDir).filter((f) => f.endsWith(".dcm") && !f.includes("_cs-2"));
        expect(sources).toHaveLength(32);
        const untouched = await readTags(path.join(workDir, "IM-00002.dcm"));
        expect(untouched.seriesDescription).toBe("CINE SA");
    });

    it("refuses a new-folder export with no output directory", async () => {
        const plan = resolveRuleSet(makeRuleSet([child()]), analysis);
        await expect(exportPlan(plan, { mode: "new-folder" })).rejects.toThrow(/output folder is required/);
    });
});

describe("exportPlan error handling", () => {
    it("records a failure and keeps exporting the rest", async () => {
        const plan = resolveRuleSet(makeRuleSet([child()]), analysis);
        plan.childSeries[0].cells[0].record = {
            ...plan.childSeries[0].cells[0].record,
            filePath: path.join(FIXTURES, "does-not-exist.dcm")
        };

        const result = await exportPlan(plan, { mode: "new-folder", outputDir: path.join(tmpRoot, "errors") });
        expect(result.stats.errorCount).toBe(1);
        expect(result.stats.writtenCount).toBe(23);
        expect(result.errors[0].message).toMatch(/ENOENT/);
    });

    it("leaves no temporary files behind", () => {
        const stray = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (e.name.includes("dcmsort-tmp")) stray.push(full);
            }
        };
        walk(tmpRoot);
        expect(stray).toEqual([]);
    });
});

describe("sanitize", () => {
    it("makes path segments safe on both platforms", () => {
        expect(sanitize("T1/VIBE: fat*sat?")).toBe("T1_VIBE__fat_sat_");
        expect(sanitize("trailing dot.")).toBe("trailing_dot");
        expect(sanitize("")).toBe("unnamed");
    });
});
