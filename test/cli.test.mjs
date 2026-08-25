import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

import cli from "../src/cli/cli.js";
import io from "../src/main/dicom-io.js";

const { parseArgs, checkFlags, matchesSeries, groupBySeries } = cli;
const { readRecord } = io;

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "src", "cli", "cli.js");
const FIXTURES = path.join(HERE, "fixtures", "data");

/** The MULTI RECON series analyzes into v1 8x4, v2 8x2, v3 8x1. */
const MULTI_RECON_UID = "1.2.826.0.1.3680043.9.7133.20.4";

function ruleFile(dir, overrides = {}) {
    const document = {
        version: 1,
        sourceSeries: [MULTI_RECON_UID],
        volumeFingerprints: { v1: "8x4@4" },
        childSeries: [
            {
                id: "cs-1",
                label: "Early phases",
                selections: [{ volumeId: "v1", slices: "*", phases: "1-2" }],
                attributes: { descriptionPrefix: "CLI:", seriesScale: 100, seriesOffset: 1 }
            }
        ],
        ...overrides
    };
    const file = path.join(dir, "rules.dcmsort.json");
    fs.writeFileSync(file, JSON.stringify(document, null, 2));
    return file;
}

/** Run the CLI as a real process, so exit codes are the ones a shell sees. */
async function cliRun(args) {
    try {
        const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
        return { code: 0, stdout, stderr };
    } catch (err) {
        return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
}

let tmp;
beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcmsort-cli-"));
});

describe("parseArgs", () => {
    it("reads a command, values, and booleans", () => {
        const { command, flags, errors } = parseArgs(["apply", "--rules", "r.json", "--folder", "/d", "--dry-run"]);
        expect(errors).toEqual([]);
        expect(command).toBe("apply");
        expect(flags).toMatchObject({ rules: "r.json", folder: "/d", dryRun: true });
    });

    it("accepts --flag=value as well as --flag value", () => {
        expect(parseArgs(["list", "--folder=/d"]).flags.folder).toBe("/d");
    });

    it("collects --series repeatedly", () => {
        expect(parseArgs(["list", "--folder", "/d", "--series", "3", "--series", "CINE"]).flags.series).toEqual([
            "3",
            "CINE"
        ]);
    });

    it("reports unknown commands and options rather than throwing", () => {
        expect(parseArgs(["frobnicate"]).errors).toEqual(['Unknown command "frobnicate"']);
        expect(parseArgs(["list", "--wat"]).errors).toEqual(['Unknown option "--wat"']);
        expect(parseArgs(["list", "--folder"]).errors).toEqual(["--folder needs a value"]);
    });
});

describe("checkFlags", () => {
    it("requires an explicit destination, so nothing is overwritten by default", () => {
        const errors = checkFlags("apply", { folder: "/d", rules: "r.json" });
        expect(errors).toEqual(["apply needs either --out <dir> or --in-place"]);
    });

    it("refuses --out together with --in-place", () => {
        const errors = checkFlags("apply", { folder: "/d", rules: "r.json", out: "/o", inPlace: true });
        expect(errors).toContain("--out and --in-place are mutually exclusive");
    });

    it("accepts a complete apply", () => {
        expect(checkFlags("apply", { folder: "/d", rules: "r.json", out: "/o" })).toEqual([]);
    });
});

describe("matchesSeries", () => {
    const group = {
        seriesInstanceUID: "1.2.3",
        records: [{ seriesNumber: 4, seriesDescription: "MULTI RECON" }]
    };

    it("matches everything when no filter is given", () => {
        expect(matchesSeries(group, [])).toBe(true);
    });

    it("matches on number, UID, and a description substring", () => {
        expect(matchesSeries(group, ["4"])).toBe(true);
        expect(matchesSeries(group, ["1.2.3"])).toBe(true);
        expect(matchesSeries(group, ["multi"])).toBe(true);
    });

    it("does not match a different series", () => {
        expect(matchesSeries(group, ["5"])).toBe(false);
        expect(matchesSeries(group, ["CINE"])).toBe(false);
    });

    it("treats a bare number as the series number, not as text", () => {
        const t2 = { seriesInstanceUID: "1.2.4", records: [{ seriesNumber: 1, seriesDescription: "T2 AX" }] };
        expect(matchesSeries(t2, ["2"])).toBe(false);
        expect(matchesSeries(t2, ["1"])).toBe(true);
        expect(matchesSeries(t2, ["T2"])).toBe(true);
    });
});

describe("groupBySeries", () => {
    it("splits records by series and orders them by series number", () => {
        const records = [
            { seriesInstanceUID: "b", seriesNumber: 9 },
            { seriesInstanceUID: "a", seriesNumber: 2 },
            { seriesInstanceUID: "b", seriesNumber: 9 }
        ];
        const groups = groupBySeries(records);
        expect(groups.map((g) => g.seriesInstanceUID)).toEqual(["a", "b"]);
        expect(groups[1].records).toHaveLength(2);
    });
});

describe("apply end to end", () => {
    it("writes the series the rules asked for, with the attributes they asked for", async () => {
        const out = path.join(tmp, "out");
        const rules = ruleFile(tmp);

        const { code, stdout } = await cliRun([
            "apply",
            "--rules", rules,
            "--folder", FIXTURES,
            "--out", out,
            "--series", MULTI_RECON_UID,
            "--quiet"
        ]);
        expect(code).toBe(0);
        expect(stdout).toContain("16 files written");

        // 8 slices x 2 phases out of the 8x4 volume.
        const dir = path.join(out, "CARDIAC_MR", "401_CLI__MULTI_RECON");
        expect(fs.readdirSync(dir)).toHaveLength(16);

        const record = await readRecord(path.join(dir, "IM-00001.dcm"));
        expect(record.seriesNumber).toBe(401);
        expect(record.seriesDescription).toBe("CLI: MULTI RECON");
        expect(record.seriesInstanceUID).not.toBe(MULTI_RECON_UID);
    });

    it("offers the rules to every series independently and skips the ones they do not fit", async () => {
        const rules = ruleFile(tmp);
        const { code, stdout } = await cliRun([
            "apply", "--rules", rules, "--folder", FIXTURES,
            "--out", path.join(tmp, "unused"), "--dry-run", "--json"
        ]);
        expect(code).toBe(0);

        const summary = JSON.parse(stdout);
        expect(summary.seriesConsidered).toBe(6);
        // T2 AX is a single-phase volume, so "phases 1-2" cannot resolve there.
        const t2 = summary.results.find((r) => r.series.startsWith("1 "));
        expect(t2.status).toBe("skipped");
        expect(summary.seriesApplied).toBeGreaterThan(1);
        expect(fs.existsSync(path.join(tmp, "unused"))).toBe(false);
    });

    it("exits 0 when the rules fit nothing at all", async () => {
        // v9 exists in no series, so every one is skipped - an empty result,
        // not a failure.
        const rules = ruleFile(tmp, {
            childSeries: [
                { id: "cs-1", label: "Nowhere", selections: [{ volumeId: "v9", slices: "*", phases: "*" }] }
            ]
        });
        const { code, stdout } = await cliRun([
            "apply", "--rules", rules, "--folder", FIXTURES,
            "--out", path.join(tmp, "none"), "--dry-run"
        ]);
        expect(code).toBe(0);
        expect(stdout).toContain("did not fit any series");
    });

    it("narrows to shape-identical series under --strict", async () => {
        const rules = ruleFile(tmp);
        const { code, stdout } = await cliRun([
            "apply", "--rules", rules, "--folder", FIXTURES,
            "--out", path.join(tmp, "strict"), "--dry-run", "--strict", "--json"
        ]);
        expect(code).toBe(0);

        const summary = JSON.parse(stdout);
        const applied = summary.results.filter((r) => r.status === "planned");
        expect(applied).toHaveLength(1);
        expect(applied[0].seriesInstanceUID).toBe(MULTI_RECON_UID);
    });

    it("fails on a missing rule file and on a folder that is not one", async () => {
        const missing = await cliRun([
            "apply", "--rules", path.join(tmp, "nope.json"), "--folder", FIXTURES, "--out", tmp
        ]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("Cannot read rule file");

        const badFolder = await cliRun(["list", "--folder", path.join(tmp, "nowhere")]);
        expect(badFolder.code).toBe(1);
        expect(badFolder.stderr).toContain("Not a folder");
    });
});
