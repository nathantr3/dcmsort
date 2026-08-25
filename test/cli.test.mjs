import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

import cli from "../src/cli/cli.js";
import io from "../src/main/dicom-io.js";

const { parseArgs, checkFlags, matchesSeries } = cli;
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
        // v1 of MULTI RECON is 8 x 4; slices are "*" so only the phase extent
        // and the volume count are required.
        requirements: { volumeCount: 3, volumes: { v1: { phases: { exact: 4 } } } },
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

/**
 * A scratch copy of the fixtures holding images and nothing else.
 *
 * Discovery walks the whole tree, so anything else lying about in the fixture
 * folder - an OS dropping, a rule file left over from a manual run - would
 * otherwise decide the outcome of these tests.
 */
function copyFixtures() {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "dcmsort-found-"));
    fs.cpSync(FIXTURES, dest, {
        recursive: true,
        filter: (src) => !src.endsWith(".DS_Store") && !src.endsWith(".dcmsort.json")
    });
    return dest;
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

    it("does not demand --rules, which apply can find in the folder", () => {
        expect(checkFlags("apply", { folder: "/d", out: "/o" })).toEqual([]);
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

    it("offers the rules to every series and applies only to matching shapes", async () => {
        const rules = ruleFile(tmp);
        const { code, stdout } = await cliRun([
            "apply", "--rules", rules, "--folder", FIXTURES,
            "--out", path.join(tmp, "unused"), "--dry-run", "--json"
        ]);
        expect(code).toBe(0);

        const summary = JSON.parse(stdout);
        expect(summary.seriesConsidered).toBe(6);

        // Only MULTI RECON analyzes into 3 volumes with a 4-phase v1.
        const applied = summary.results.filter((r) => r.status === "planned");
        expect(applied.map((r) => r.seriesInstanceUID)).toEqual([MULTI_RECON_UID]);

        // T2 AX is one single-phase volume: wrong on both counts.
        const t2 = summary.results.find((r) => r.series.startsWith("1 "));
        expect(t2.status).toBe("skipped");
        expect(t2.reason).toMatch(/built on 3 volumes; this selection has 1/);

        expect(fs.existsSync(path.join(tmp, "unused"))).toBe(false);
    });

    it("skips a series whose indexed axis is the wrong size", async () => {
        // CINE SA is a single 8 x 4 volume: the volume count is wrong, and a
        // rule needing 9 phases would not fit its v1 either.
        const rules = ruleFile(tmp, {
            requirements: { volumeCount: 1, volumes: { v1: { phases: { exact: 9 } } } }
        });
        const { code, stdout } = await cliRun([
            "apply", "--rules", rules, "--folder", FIXTURES, "--series", "3",
            "--out", path.join(tmp, "wrong-shape"), "--dry-run", "--json"
        ]);
        expect(code).toBe(0);

        const [only] = JSON.parse(stdout).results;
        expect(only.status).toBe("skipped");
        expect(only.reason).toMatch(/v1 needs exactly 9 phases; this volume has 4/);
    });

    it("exits 0 when the rules fit nothing at all", async () => {
        // v9 exists in no series, so every one is skipped - an empty result,
        // not a failure.
        const rules = ruleFile(tmp, {
            requirements: { volumeCount: 99, volumes: {} },
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

    it("finds the rule file in the folder when --rules is left out", async () => {
        const folder = copyFixtures();
        ruleFile(folder); // writes rules.dcmsort.json into the folder being applied to

        const { code, stdout } = await cliRun([
            "apply", "--folder", folder, "--out", path.join(folder, "out"), "--dry-run", "--json"
        ]);
        expect(code).toBe(0);

        // --json is quiet, so the file it picked shows up in the summary
        // rather than as commentary.
        const summary = JSON.parse(stdout);
        expect(summary.rules).toBe(path.join(folder, "rules.dcmsort.json"));
        expect(summary.results.filter((r) => r.status === "planned")).toHaveLength(1);
    });

    it("takes a lone rule file whatever it is called, but not one of several", async () => {
        const folder = copyFixtures();
        fs.renameSync(ruleFile(folder), path.join(folder, "cardiac.dcmsort.json"));

        const args = ["apply", "--folder", folder, "--out", path.join(folder, "out"), "--dry-run"];
        const lone = await cliRun(args);
        expect(lone.code).toBe(0);
        expect(lone.stderr).toContain("Using cardiac.dcmsort.json");

        fs.copyFileSync(path.join(folder, "cardiac.dcmsort.json"), path.join(folder, "other.dcmsort.json"));
        const several = await cliRun(args);
        expect(several.code).toBe(1);
        expect(several.stderr).toMatch(/holds 2 rule files/);
        expect(several.stderr).toMatch(/Name the one you want with --rules/);
    });

    it("refuses to pick up a rule file that is not usable", async () => {
        const folder = copyFixtures();
        const args = ["apply", "--folder", folder, "--out", path.join(folder, "out"), "--dry-run"];

        const none = await cliRun(args);
        expect(none.code).toBe(1);
        expect(none.stderr).toMatch(/No usable rule file in/);

        // A file that looked like rules but could not be used says so by name,
        // rather than being silently passed over.
        fs.writeFileSync(path.join(folder, "rules.dcmsort.json"), '{ "version": 1, ');
        const broken = await cliRun(args);
        expect(broken.code).toBe(1);
        expect(broken.stderr).toMatch(/No usable rule file/);
        expect(broken.stderr).toMatch(/rules\.dcmsort\.json: .*JSON/);

        fs.writeFileSync(path.join(folder, "rules.dcmsort.json"), '{ "version": 1, "childSeries": [] }');
        const empty = await cliRun(args);
        expect(empty.code).toBe(1);
        expect(empty.stderr).toMatch(/rules\.dcmsort\.json: it contains no child series/);
    });

    it("merges the folder into one series when the rule set says so", async () => {
        const folder = copyFixtures();
        // Keep only MULTI RECON, whose three volumes are what the rules need.
        for (const study of fs.readdirSync(folder)) {
            const studyDir = path.join(folder, study);
            if (!fs.statSync(studyDir).isDirectory()) continue;
            for (const series of fs.readdirSync(studyDir)) {
                if (series !== "series4") fs.rmSync(path.join(studyDir, series), { recursive: true, force: true });
            }
        }

        const rules = ruleFile(folder, {
            mode: "merge",
            childSeries: [
                { id: "cs-1", label: "First", selections: [{ volumeId: "v2", slices: "*", phases: "*" }],
                  attributes: { descriptionPrefix: "JOINED:", seriesScale: 100, seriesOffset: 1 } },
                { id: "cs-2", label: "Second", selections: [{ volumeId: "v3", slices: "*", phases: "*" }],
                  attributes: { descriptionPrefix: "JOINED:", seriesScale: 100, seriesOffset: 1 } }
            ]
        });

        const out = path.join(folder, "out");
        const { code, stdout } = await cliRun(["apply", "--rules", rules, "--folder", folder, "--out", out, "--json"]);
        expect(code).toBe(0);

        const summary = JSON.parse(stdout);
        expect(summary.mode).toBe("merge");
        expect(summary.segments.map((s) => [s.instanceStart, s.instanceEnd])).toEqual([[1, 16], [17, 24]]);

        // v2 is 8x2 and v3 is 8x1: one series of 24 images, numbered straight
        // through in segment order.
        const written = fs.readdirSync(out, { recursive: true }).filter((f) => String(f).endsWith(".dcm"));
        expect(written).toHaveLength(24);

        const records = await Promise.all(written.map((f) => readRecord(path.join(out, String(f)))));
        expect(new Set(records.map((r) => r.seriesInstanceUID)).size).toBe(1);
        expect(records[0].seriesDescription).toBe("JOINED: MULTI RECON");
        expect(records.map((r) => r.instanceNumber).sort((a, b) => a - b)).toEqual(
            Array.from({ length: 24 }, (_, i) => i + 1)
        );
    });

    it("aborts a merge whose shape the folder does not have", async () => {
        const folder = copyFixtures();
        const rules = ruleFile(folder, {
            mode: "merge",
            requirements: { volumeCount: 99, volumes: {} },
            childSeries: [
                { id: "cs-1", label: "First", selections: [{ volumeId: "v1", slices: "*", phases: "*" }] }
            ]
        });

        const { code, stderr } = await cliRun([
            "apply", "--rules", rules, "--folder", folder, "--out", path.join(folder, "out"), "--dry-run"
        ]);
        // Nothing else to fall back to, so a mismatch is a failure, not a skip.
        expect(code).toBe(1);
        expect(stderr).toMatch(/built on 99 volumes/);
        expect(stderr).toMatch(/narrow it with --series/);
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
