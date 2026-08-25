#!/usr/bin/env node
"use strict";

/**
 * The headless half of dcmsort: apply a saved rule set to a folder without
 * opening the GUI.
 *
 * Everything here is a thin driver over the same engine the app uses
 * (scanner -> analyze -> rules -> export); no DICOM logic lives in this file.
 *
 * The one deliberate difference from the GUI is selection. The app analyzes
 * the series you tick as a single selection, so volume ids run v1..vN across
 * all of them. The CLI instead treats **every series independently**: each is
 * analyzed on its own, so its volumes always start at v1, and the rule set is
 * offered to each in turn. That is what lets one saved file be re-run over a
 * folder it was not built on. It also means "these rules do not fit this
 * series" is the ordinary case rather than a failure: such a series is skipped
 * with a reason and the run carries on.
 */

const fsp = require("fs/promises");
const path = require("path");

const { scanDirectory } = require("../main/scanner");
const { buildLibrary, groupBySeries } = require("../main/library");
const { analyzeSelection } = require("../main/analyze");
const rules = require("../main/rules");
const { exportPlan } = require("../main/export");

const VERSION = require("../../package.json").version;

const USAGE = `dcmsort ${VERSION} - interactive DICOM sorting, splitting, and attribute modification

Usage:
  dcmsort apply   [--rules <file>] --folder <dir> (--out <dir> | --in-place) [options]
  dcmsort list    --folder <dir> [options]
  dcmsort analyze --folder <dir> [options]

Commands:
  apply     Apply a saved rule set to every matching series in the folder.
  list      Print the exams and series found in the folder.
  analyze   Print the volumes detected in each series (slices x phases).

Options:
  --folder <dir>      Folder of DICOMs to read, searched recursively.
  --rules <file>      Rule set JSON saved from the app (apply only). Left out,
                      apply searches --folder and everything under it for a
                      *.dcmsort.json, and uses it if exactly one is usable.
  --out <dir>         Write a new tree under <dir> (apply only).
  --in-place          Overwrite the source files (apply only). Destructive.
  --series <match>    Only touch series matching this SeriesNumber, a substring
                      of the SeriesDescription, or a SeriesInstanceUID.
                      Repeatable; default is every series found.
  --phase-key <tag>   Force the phase-ordering attribute for every volume,
                      e.g. TriggerTime. Overrides the rule file.
  --dry-run           Report what apply would write, and write nothing.
  --json              Emit the result as JSON on stdout.
  --quiet             Suppress progress and per-series chatter.
  --version           Print the version.
  --help              Print this message.

A rule set records the shape it needs - how many volumes, and the extent of
only those axes its selections index - so it is offered to every series and
applied to the ones that match.

Exit status is 0 when nothing failed - including a run where every series was
skipped because the rules did not fit - and 1 when a file could not be read or
written.`;

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

const COMMANDS = new Set(["apply", "list", "analyze"]);
const TAKES_VALUE = new Set(["folder", "rules", "out", "series", "phase-key"]);
const BOOLEANS = new Set(["in-place", "dry-run", "json", "quiet", "help", "version"]);

/**
 * Parse argv into a command plus flags. Returns `errors` rather than throwing
 * so a caller can report every problem in one go.
 *
 * @param {string[]} argv arguments after the node binary and script
 */
function parseArgs(argv) {
    const flags = { series: [] };
    const errors = [];
    let command = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (!arg.startsWith("-")) {
            if (command) errors.push(`Unexpected argument "${arg}"`);
            else if (!COMMANDS.has(arg)) errors.push(`Unknown command "${arg}"`);
            else command = arg;
            continue;
        }

        // Accept both "--flag value" and "--flag=value".
        const [name, inlineValue] = arg.replace(/^--?/, "").split(/=(.*)/s);

        if (BOOLEANS.has(name)) {
            if (inlineValue !== undefined) errors.push(`--${name} takes no value`);
            flags[camel(name)] = true;
            continue;
        }

        if (!TAKES_VALUE.has(name)) {
            errors.push(`Unknown option "${arg}"`);
            continue;
        }

        const value = inlineValue !== undefined ? inlineValue : argv[++i];
        if (value === undefined) {
            errors.push(`--${name} needs a value`);
            continue;
        }
        if (name === "series") flags.series.push(value);
        else flags[camel(name)] = value;
    }

    return { command, flags, errors };
}

function camel(name) {
    return name.replace(/-(.)/g, (_, c) => c.toUpperCase());
}

/** Validate the flag combination for a command. Returns a list of problems. */
function checkFlags(command, flags) {
    const errors = [];
    if (!flags.folder) errors.push("--folder is required");

    if (command === "apply") {
        // --rules is optional: without it, apply looks in --folder.
        // Overwriting the source images is never something to fall into by
        // default, so an output destination has to be stated outright.
        if (!flags.out && !flags.inPlace) errors.push("apply needs either --out <dir> or --in-place");
        if (flags.out && flags.inPlace) errors.push("--out and --in-place are mutually exclusive");
    } else {
        for (const only of ["rules", "out", "inPlace", "dryRun"]) {
            if (flags[only]) errors.push(`--${only.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} only applies to apply`);
        }
    }
    return errors;
}

/* ------------------------------------------------------------------ */
/* Series selection                                                    */
/* ------------------------------------------------------------------ */

/**
 * Does a series match any of the --series filters? A filter is a
 * SeriesInstanceUID, a SeriesNumber, or a case-insensitive substring of the
 * SeriesDescription; no filters means everything matches.
 */
function matchesSeries(group, filters) {
    if (!filters.length) return true;
    const sample = group.records[0];
    const description = String(sample.seriesDescription ?? "").toLowerCase();

    return filters.some((filter) => {
        if (filter === group.seriesInstanceUID) return true;
        // A bare number means the SeriesNumber and nothing else: matching it as
        // text too would make `--series 2` pick up "T2 AX".
        if (/^\d+$/.test(filter.trim())) return Number(filter) === sample.seriesNumber;
        return Boolean(filter) && description.includes(filter.toLowerCase());
    });
}

function seriesLabel(group) {
    const sample = group.records[0];
    return `${sample.seriesNumber ?? "-"} ${sample.seriesDescription || "(no description)"}`;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

/**
 * Progress and commentary go to stderr, results to stdout, so `--json` stays
 * pipeable while a human still sees what is happening.
 */
function makeReporter(flags) {
    const quiet = Boolean(flags.quiet || flags.json);
    let progressOpen = false;

    return {
        say(text) {
            if (!quiet) process.stderr.write(`${text}\n`);
        },
        progress(text) {
            if (quiet || !process.stderr.isTTY) return;
            process.stderr.write(`\r\x1b[2K${text}`);
            progressOpen = true;
        },
        endProgress() {
            if (progressOpen) process.stderr.write("\r\x1b[2K");
            progressOpen = false;
        },
        out(text) {
            process.stdout.write(`${text}\n`);
        }
    };
}

/* ------------------------------------------------------------------ */
/* Shared setup                                                        */
/* ------------------------------------------------------------------ */

async function assertFolder(folder) {
    const stat = await fsp.stat(folder).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new Error(`Not a folder: ${folder}`);
}

async function scanFolder(folder, report) {
    await assertFolder(folder);

    const { records, errors, stats } = await scanDirectory(folder, {
        onProgress: (p) =>
            report.progress(
                p.phase === "walk"
                    ? `${p.filesFound} files found...`
                    : `${p.processed} / ${p.filesFound} read - ${p.dicomCount} DICOM`
            )
    });
    report.endProgress();

    if (!records.length) throw new Error(`No DICOM files found in ${folder}`);
    return { records, errors, stats };
}

/**
 * Analyze one series on its own, so its volume ids always start at v1.
 *
 * `--phase-key` has to be applied by volume id, which is only known once the
 * volumes exist, so a forced key means analyzing twice. Both passes are pure
 * in-memory work over records already read.
 */
function analyzeOne(group, { phaseKeyOverrides, forcedPhaseKey }) {
    const first = analyzeSelection([group], { phaseKeyOverrides });
    if (!forcedPhaseKey) return first;

    const forced = Object.fromEntries(first.volumes.map((v) => [v.id, forcedPhaseKey]));
    return analyzeSelection([group], { phaseKeyOverrides: forced });
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdList(flags, report) {
    const { records, stats } = await scanFolder(flags.folder, report);
    const library = buildLibrary(records);
    const filters = flags.series;

    const studies = library.studies
        .map((study) => ({
            ...study,
            series: study.series.filter((s) =>
                matchesSeries({ seriesInstanceUID: s.seriesInstanceUID, records: [s] }, filters)
            )
        }))
        .filter((study) => study.series.length);

    if (flags.json) {
        report.out(JSON.stringify({ folder: flags.folder, stats, studies }, null, 2));
        return 0;
    }

    for (const study of studies) {
        report.out(
            `${study.patientName || "(no name)"}  |  ${study.studyDescription || "(no description)"}  |  ${study.studyDate || "-"}`
        );
        for (const s of study.series) {
            report.out(
                `  ${String(s.seriesNumber ?? "-").padStart(4)}  ${String(s.modality || "--").padEnd(3)}  ` +
                    `${String(s.fileCount).padStart(5)} files  ${s.seriesDescription || "(no description)"}`
            );
            report.out(`        ${s.seriesInstanceUID}`);
        }
    }
    report.out(`\n${studies.length} exam(s), ${studies.reduce((n, s) => n + s.series.length, 0)} series`);
    return 0;
}

async function cmdAnalyze(flags, report) {
    const { records } = await scanFolder(flags.folder, report);
    const groups = groupBySeries(records).filter((g) => matchesSeries(g, flags.series));
    const out = [];

    for (const group of groups) {
        const analysis = analyzeOne(group, { phaseKeyOverrides: {}, forcedPhaseKey: flags.phaseKey });
        out.push({
            seriesInstanceUID: group.seriesInstanceUID,
            label: seriesLabel(group),
            fileCount: group.records.length,
            warnings: analysis.warnings,
            volumes: analysis.volumes.map((v) => ({
                id: v.id,
                slices: v.slices,
                phases: v.phases,
                fileCount: v.fileCount,
                phaseKey: v.phaseKey,
                phaseKeyConfident: v.phaseKeyConfident
            }))
        });
    }

    if (flags.json) {
        report.out(JSON.stringify({ folder: flags.folder, series: out }, null, 2));
        return 0;
    }

    for (const s of out) {
        report.out(`${s.label}  (${s.fileCount} files)`);
        for (const v of s.volumes) {
            const key = v.phases > 1 ? `  phases by ${v.phaseKey}${v.phaseKeyConfident ? "" : " (uncertain)"}` : "";
            report.out(`  ${v.id}  ${v.slices} x ${v.phases}  ${String(v.fileCount).padStart(5)} files${key}`);
        }
        for (const w of s.warnings) report.out(`  ! ${w}`);
    }
    return 0;
}

async function cmdApply(flags, report) {
    await assertFolder(flags.folder);
    const { filePath: rulesPath, ruleSet } = await resolveRuleFile(flags, report);
    const { records } = await scanFolder(flags.folder, report);

    const target = flags.inPlace
        ? { mode: "in-place" }
        : { mode: "new-folder", outputDir: path.resolve(flags.out) };

    const groups = groupBySeries(records).filter((g) => matchesSeries(g, flags.series));
    if (!groups.length) {
        throw new Error(`No series in ${flags.folder} matched ${flags.series.join(", ")}`);
    }

    const results = [];
    let failed = false;

    for (const group of groups) {
        const outcome = await applyToSeries(group, { ruleSet, target, flags, report });
        results.push({ series: seriesLabel(group), seriesInstanceUID: group.seriesInstanceUID, ...outcome });
        if (outcome.status === "failed" || outcome.errorCount) failed = true;

        if (outcome.status === "skipped") report.say(`  skip  ${seriesLabel(group)} - ${outcome.reason}`);
        else if (outcome.status === "planned") {
            report.say(`  plan  ${seriesLabel(group)} - ${outcome.fileCount} files in ${outcome.childSeries.length} series`);
        } else {
            report.say(
                `  done  ${seriesLabel(group)} - ${outcome.writtenCount} written` +
                    (outcome.errorCount ? `, ${outcome.errorCount} failed` : "")
            );
        }
    }

    const applied = results.filter((r) => r.status === "exported" || r.status === "planned");
    const summary = {
        folder: flags.folder,
        rules: path.resolve(rulesPath),
        target,
        dryRun: Boolean(flags.dryRun),
        seriesConsidered: results.length,
        seriesApplied: applied.length,
        filesWritten: results.reduce((n, r) => n + (r.writtenCount || 0), 0),
        filesPlanned: results.reduce((n, r) => n + (r.fileCount || 0), 0),
        errorCount: results.reduce((n, r) => n + (r.errorCount || 0), 0),
        results
    };

    if (flags.json) report.out(JSON.stringify(summary, null, 2));
    else report.out(renderSummary(summary));

    return failed ? 1 : 0;
}

/** Run one series through fit check, resolution, and export. */
async function applyToSeries(group, { ruleSet, target, flags, report }) {
    const analysis = analyzeOne(group, {
        phaseKeyOverrides: ruleSet.phaseKeyOverrides,
        forcedPhaseKey: flags.phaseKey
    });

    // A rule set is offered to every series, so a shape that does not match is
    // an expected miss rather than a mistake: these rules were written for a
    // differently shaped series.
    const problems = rules.checkRuleSetFit(ruleSet, analysis);
    if (problems.length) return { status: "skipped", reason: problems.map((p) => p.message).join(" ") };

    const plan = rules.resolveRuleSet(ruleSet, analysis);
    const blocking = plan.conflicts.filter((c) => c.level === "error");
    if (blocking.length) return { status: "skipped", reason: blocking.map((c) => c.message).join(" ") };

    const childSeries = plan.childSeries
        .filter((cs) => cs.fileCount > 0)
        .map((cs) => ({
            id: cs.id,
            label: cs.label,
            seriesNumber: cs.seriesNumber,
            seriesDescription: cs.seriesDescription,
            fileCount: cs.fileCount
        }));
    const fileCount = childSeries.reduce((n, cs) => n + cs.fileCount, 0);
    if (!fileCount) return { status: "skipped", reason: "the rules selected no files from this series" };

    if (flags.dryRun) return { status: "planned", childSeries, fileCount };

    const result = await exportPlan(plan, target, {
        onProgress: (p) =>
            report.progress(`${seriesLabel(group)}: ${p.processed} / ${p.totalFiles} written`)
    });
    report.endProgress();

    for (const err of result.errors.slice(0, 10)) report.say(`  error ${err.filePath}: ${err.message}`);

    return {
        status: "exported",
        childSeries,
        fileCount,
        writtenCount: result.stats.writtenCount,
        errorCount: result.stats.errorCount
    };
}

/**
 * The rules to apply: the file named with --rules, or one found in the folder
 * being processed - the same discovery the app does when a folder is opened.
 *
 * The folder is searched all the way down, since a rule file often sits beside
 * the series it was built from. Only genuinely usable files count - one that
 * will not parse or carries no rules is passed over, with the reason - and
 * more than one is a choice only the user can make.
 */
async function resolveRuleFile(flags, report) {
    if (flags.rules) return { filePath: flags.rules, ruleSet: await loadRuleFile(flags.rules) };

    const { usable, rejected } = await rules.collectRuleFiles(flags.folder);

    if (usable.length > 1) {
        const list = usable.map((c) => `  ${path.relative(flags.folder, c.filePath)}`).join("\n");
        throw new Error(
            `${flags.folder} holds ${usable.length} rule files:\n${list}\n` +
                `Name the one you want with --rules <file>.`
        );
    }

    if (!usable.length) {
        // Say why a file that looked like one was passed over, or the user is
        // left wondering why their rules.dcmsort.json was ignored.
        const why = rejected.map((r) => `\n  ${path.relative(flags.folder, r.filePath)}: ${r.reason}`).join("");
        throw new Error(`No usable rule file in ${flags.folder}.${why}\nName one with --rules <file>.`);
    }

    const [found] = usable;
    report.say(`Using ${path.relative(flags.folder, found.filePath)} found in ${flags.folder}`);
    return found;
}

async function loadRuleFile(file) {
    let raw;
    try {
        raw = await fsp.readFile(file, "utf8");
    } catch (err) {
        throw new Error(`Cannot read rule file ${file}: ${err.message}`);
    }
    try {
        return rules.normalizeRuleSet(JSON.parse(raw));
    } catch (err) {
        throw new Error(`${file} is not a valid rule file: ${err.message}`);
    }
}

function renderSummary(summary) {
    const lines = [];
    for (const r of summary.results) {
        if (r.status === "skipped") lines.push(`skipped   ${r.series}  (${r.reason})`);
        else if (r.status === "planned") lines.push(`would do  ${r.series}  ${r.fileCount} files`);
        else lines.push(`exported  ${r.series}  ${r.writtenCount} files`);
    }

    lines.push(
        summary.dryRun
            ? `\nwould apply to ${summary.seriesApplied} of ${summary.seriesConsidered} series, ${summary.filesPlanned} files`
            : `\napplied to ${summary.seriesApplied} of ${summary.seriesConsidered} series, ` +
              `${summary.filesWritten} files written` +
              (summary.errorCount ? `, ${summary.errorCount} failed` : "")
    );
    if (!summary.seriesApplied) {
        lines.push("These rules did not fit any series in this folder. `dcmsort analyze` shows the volume shapes they would need.");
    }
    return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function main(argv = process.argv.slice(2)) {
    const { command, flags, errors } = parseArgs(argv);

    if (flags.version) {
        process.stdout.write(`${VERSION}\n`);
        return 0;
    }
    if (flags.help || (!command && !argv.length)) {
        process.stdout.write(`${USAGE}\n`);
        return flags.help || !argv.length ? 0 : 1;
    }

    const problems = [...errors, ...(command ? checkFlags(command, flags) : ["No command given"])];
    if (problems.length) {
        for (const p of problems) process.stderr.write(`dcmsort: ${p}\n`);
        process.stderr.write("Try `dcmsort --help`.\n");
        return 1;
    }

    const report = makeReporter(flags);
    const run = { apply: cmdApply, list: cmdList, analyze: cmdAnalyze }[command];
    return run(flags, report);
}

if (require.main === module) {
    main()
        .then((code) => process.exit(code))
        .catch((err) => {
            process.stderr.write(`dcmsort: ${err.message}\n`);
            process.exit(1);
        });
}

module.exports = { main, parseArgs, checkFlags, matchesSeries, renderSummary };
