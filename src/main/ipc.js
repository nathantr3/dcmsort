"use strict";

/**
 * The whole main/renderer boundary.
 *
 * Scan records are heavy and stay here; the renderer only ever receives the
 * lightweight projections it needs to draw. Volume grids, for instance, cross
 * the wire as file paths rather than full metadata records.
 */

const fsp = require("fs/promises");
const path = require("path");
const { ipcMain, dialog, BrowserWindow } = require("electron");

const { scanDirectory } = require("./scanner");
const { buildLibrary, groupBySeries } = require("./library");
const { analyzeSelection } = require("./analyze");
const rules = require("./rules");
const { exportPlan } = require("./export");

/** Everything the app knows about the currently loaded folder. */
const state = {
    root: null,
    records: [],
    recordsByPath: new Map(),
    analysis: null,
    scanSignal: null,
    exportSignal: null
};

function send(event, channel, payload) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ */
/* Renderer-facing projections                                         */
/* ------------------------------------------------------------------ */

function fileEntry(record) {
    return {
        filePath: record.filePath,
        name: path.basename(record.filePath),
        instanceNumber: record.instanceNumber,
        seriesInstanceUID: record.seriesInstanceUID
    };
}

function volumeForRenderer(v) {
    return {
        id: v.id,
        index: v.index,
        label: v.label,
        slices: v.slices,
        phases: v.phases,
        fileCount: v.fileCount,
        sliceKeySource: v.sliceKeySource,
        phaseKey: v.phaseKey,
        phaseKeyConfident: v.phaseKeyConfident,
        phaseKeyCandidates: v.phaseKeyCandidates,
        distinguishers: v.distinguishers,
        seriesInstanceUID: v.seriesInstanceUID,
        seriesNumber: v.seriesNumber,
        seriesDescription: v.seriesDescription,
        grid: v.grid.map((row) => row.map((r) => r.filePath))
    };
}

function planForRenderer(plan) {
    return {
        childSeries: plan.childSeries.map((cs) => ({
            id: cs.id,
            label: cs.label,
            color: cs.color,
            fileCount: cs.fileCount,
            selectionCounts: cs.selectionCounts,
            seriesNumber: cs.seriesNumber,
            seriesDescription: cs.seriesDescription,
            baseSeriesNumber: cs.baseSeriesNumber,
            baseSeriesDescription: cs.baseSeriesDescription,
            cells: cs.cells.map((c) => ({
                filePath: c.record.filePath,
                volumeId: c.volumeId,
                sliceIndex: c.sliceIndex,
                phaseIndex: c.phaseIndex,
                outputInstanceNumber: c.outputInstanceNumber
            }))
        })),
        claims: Object.fromEntries(plan.claimsByPath),
        unclaimedPaths: plan.unclaimedPaths,
        conflicts: plan.conflicts
    };
}

/* ------------------------------------------------------------------ */
/* Rule file discovery                                                 */
/* ------------------------------------------------------------------ */

/**
 * Look for a rule set living alongside the DICOMs, so re-opening a folder does
 * not mean re-finding its rules by hand. A rule file that will not parse is
 * reported and skipped: it must never take the scan down with it.
 *
 * @returns {Promise<{filePath: string, ruleSet: object, fittingSeries: string[]} | {filePath: string, error: string} | {ambiguous: string[]} | null>}
 */
async function discoverRuleSet(root, records) {
    const found = await rules.findRuleFile(root);
    if (!found || !found.filePath) return found;

    try {
        const raw = JSON.parse(await fsp.readFile(found.filePath, "utf8"));
        const ruleSet = rules.normalizeRuleSet(raw);
        return { filePath: found.filePath, ruleSet, fittingSeries: seriesFitting(ruleSet, records) };
    } catch (err) {
        return { filePath: found.filePath, error: err.message };
    }
}

/**
 * Which series a rule set could be applied to, by shape alone.
 *
 * Each series is analyzed on its own, exactly as the CLI applies rules, so its
 * volumes start at v1 and the requirements mean the same thing in both places.
 * That is one analysis per series in the folder, but it is in-memory work over
 * records already read and happens once per scan.
 */
function seriesFitting(ruleSet, records) {
    const fitting = [];

    for (const group of groupBySeries(records)) {
        const analysis = analyzeSelection([group], { phaseKeyOverrides: ruleSet.phaseKeyOverrides });
        if (!rules.checkRuleSetFit(ruleSet, analysis).length) fitting.push(group.seriesInstanceUID);
    }
    return fitting;
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

function register() {
    ipcMain.handle("dialog:chooseDirectory", async (event, { title } = {}) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            title: title || "Choose a folder to scan",
            properties: ["openDirectory", "createDirectory"]
        });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle("scan:start", async (event, { root }) => {
        state.scanSignal = { cancelled: false };
        state.root = root;

        const { records, errors, stats } = await scanDirectory(root, {
            signal: state.scanSignal,
            onProgress: (p) => send(event, "scan:progress", p)
        });

        state.records = records;
        state.recordsByPath = new Map(records.map((r) => [r.filePath, r]));
        state.analysis = null;

        return {
            root,
            library: buildLibrary(records),
            stats,
            errors: errors.slice(0, 100),
            ruleFile: await discoverRuleSet(root, records)
        };
    });

    ipcMain.handle("scan:cancel", () => {
        if (state.scanSignal) state.scanSignal.cancelled = true;
        return true;
    });

    ipcMain.handle("analyze:selection", async (_event, { seriesInstanceUIDs, phaseKeyOverrides }) => {
        const wanted = new Set(seriesInstanceUIDs);
        const groups = [];

        // Preserve the order the user selected series in, so volume numbering
        // follows the tree rather than scan order.
        for (const uid of seriesInstanceUIDs) {
            const records = state.records.filter((r) => r.seriesInstanceUID === uid);
            if (records.length) groups.push({ seriesInstanceUID: uid, records });
        }

        const analysis = analyzeSelection(groups, { phaseKeyOverrides: phaseKeyOverrides || {} });
        state.analysis = analysis;

        return {
            volumes: analysis.volumes.map(volumeForRenderer),
            warnings: analysis.warnings,
            series: groups.map((g) => ({
                seriesInstanceUID: g.seriesInstanceUID,
                seriesNumber: g.records[0].seriesNumber,
                seriesDescription: g.records[0].seriesDescription,
                studyDescription: g.records[0].studyDescription,
                fileCount: g.records.length,
                files: g.records.map(fileEntry)
            })),
            selectedCount: [...wanted].length
        };
    });

    ipcMain.handle("rules:preview", async (_event, { ruleSet }) => {
        if (!state.analysis) throw new Error("Nothing has been analyzed yet");
        const plan = rules.resolveRuleSet(ruleSet, state.analysis);
        return planForRenderer(plan);
    });

    ipcMain.handle("rules:check", async (_event, { ruleSet }) => {
        if (!state.analysis) return [];
        return rules.checkRuleSetFit(ruleSet, state.analysis);
    });

    ipcMain.handle("rules:save", async (event, { ruleSet, phaseKeyOverrides }) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showSaveDialog(win, {
            title: "Save rule set",
            defaultPath: state.root ? path.join(state.root, rules.RULE_FILE_NAME) : rules.RULE_FILE_NAME,
            filters: [{ name: "dcmsort rules", extensions: ["json"] }]
        });
        if (result.canceled) return null;

        // A rule file carries only what it needs to match new data and apply
        // to it: the shape it requires, how to order phases, and the rules.
        const document = {
            ...rules.normalizeRuleSet(ruleSet),
            requirements: rules.describeRequirements(ruleSet, state.analysis),
            // The phase ordering decides what "phases 1-3" selects, so an
            // override the user made by hand has to travel with the rules.
            phaseKeyOverrides: phaseKeyOverrides || {}
        };
        await fsp.writeFile(result.filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
        return result.filePath;
    });

    ipcMain.handle("rules:load", async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            title: "Load rule set",
            defaultPath: state.root || undefined,
            properties: ["openFile"],
            filters: [{ name: "dcmsort rules", extensions: ["json"] }]
        });
        if (result.canceled) return null;

        const raw = JSON.parse(await fsp.readFile(result.filePaths[0], "utf8"));
        const ruleSet = rules.normalizeRuleSet(raw);
        return {
            filePath: result.filePaths[0],
            ruleSet,
            problems: state.analysis ? rules.checkRuleSetFit(ruleSet, state.analysis) : []
        };
    });

    ipcMain.handle("export:run", async (event, { ruleSet, target }) => {
        if (!state.analysis) throw new Error("Nothing has been analyzed yet");
        state.exportSignal = { cancelled: false };

        const plan = rules.resolveRuleSet(ruleSet, state.analysis);
        const blocking = plan.conflicts.filter((c) => c.level === "error");
        if (blocking.length) {
            return { blocked: true, conflicts: blocking };
        }

        const result = await exportPlan(plan, target, {
            signal: state.exportSignal,
            onProgress: (p) => send(event, "export:progress", p)
        });
        return { blocked: false, ...result, errors: result.errors.slice(0, 200) };
    });

    ipcMain.handle("export:cancel", () => {
        if (state.exportSignal) state.exportSignal.cancelled = true;
        return true;
    });

    ipcMain.handle("shell:revealPath", async (_event, { targetPath }) => {
        const { shell } = require("electron");
        shell.showItemInFolder(targetPath);
        return true;
    });
}

module.exports = { register, state };
