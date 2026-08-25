import { el, clear, $, pluralize } from "./dom.js";
import { renderLibrary } from "./library-view.js";
import { renderFileList, paintFileList, setOnlyClaimed, fileListSummary } from "./file-list.js";
import { renderVolumePanel, paintVolumePanel } from "./volume-panel.js";
import { renderRuleEditor, resetRuleEditor, paletteColor, PALETTE } from "./rule-editor.js";
import { renderAttrEditor, resetAttrEditor } from "./attr-editor.js";
import { initExportDialog, openExportDialog } from "./export-dialog.js";

/**
 * App coordinator: owns the state, wires the views, and is the only module that
 * talks to the main process.
 *
 * Rendering is split deliberately. Structure (the file list, the volume cards)
 * is rebuilt only when the analysis changes; claim colours repaint on every
 * preview, which happens on every keystroke in the rule editor.
 */

const state = {
    stage: "library",
    root: null,
    library: null,
    selectedSeries: new Set(),
    analysis: null,
    phaseKeyOverrides: {},
    ruleSet: { version: 1, childSeries: [] },
    preview: null,
    focusedChildId: null,
    messages: [],
    nextChildIndex: 0,
    // A rule set found next to the DICOMs, waiting for an analysis to apply to.
    pendingRuleSet: null,
    pendingRuleFile: null
};

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

function renderMessages(box, messages) {
    clear(box);
    for (const m of messages) {
        box.append(el("div", { class: `message ${m.level || "info"}`, text: m.message }));
    }
}

function setMessages(messages) {
    state.messages = messages;
    renderMessages($("#workspace-messages"), messages);
}

function setLibraryMessages(messages) {
    renderMessages($("#library-messages"), messages);
}

/** Last path segment, for naming a rule file in a message. */
function basename(filePath) {
    return String(filePath || "").split(/[\\/]/).pop();
}

/* ------------------------------------------------------------------ */
/* Stage A: library                                                    */
/* ------------------------------------------------------------------ */

function updateLibrarySelectionUI() {
    const count = state.selectedSeries.size;
    $("#library-selection-summary").textContent = count
        ? `${pluralize(count, "series", "series")} selected`
        : "No series selected";
    $("#btn-analyze").disabled = count === 0;
}

function renderLibraryStage() {
    const hasLibrary = Boolean(state.library && state.library.studies.length);
    $("#library-empty").hidden = hasLibrary;
    $("#library-tree").hidden = !hasLibrary;
    $("#library-footer").hidden = !hasLibrary;

    if (hasLibrary) {
        renderLibrary($("#library-tree"), state.library, state.selectedSeries, libraryActions);
        const { totals } = state.library;
        $("#library-subtitle").textContent =
            `${state.root}  -  ${pluralize(totals.studies, "exam")}, ${pluralize(totals.series, "series", "series")}, ${pluralize(totals.files, "image")}`;
    }
    updateLibrarySelectionUI();
}

const libraryActions = {
    toggleSeries(uid) {
        if (state.selectedSeries.has(uid)) state.selectedSeries.delete(uid);
        else state.selectedSeries.add(uid);
        renderLibraryStage();
    },
    setSeriesSelection(uids, selected) {
        for (const uid of uids) {
            if (selected) state.selectedSeries.add(uid);
            else state.selectedSeries.delete(uid);
        }
        renderLibraryStage();
    }
};

async function chooseAndScan() {
    const root = await window.dcmsort.chooseDirectory();
    if (!root) return;
    await scan(root);
}

async function scan(root) {
    state.pendingRuleSet = null;
    state.pendingRuleFile = null;
    setLibraryMessages([]);

    const bar = $("#scan-progress");
    bar.classList.remove("hidden");
    const fill = bar.querySelector(".progress-fill");
    const label = bar.querySelector(".progress-label");
    fill.style.width = "0%";
    label.textContent = "Walking folders...";

    const unsubscribe = window.dcmsort.onScanProgress((p) => {
        if (p.phase === "walk") {
            label.textContent = `${p.filesFound} files found`;
            fill.style.width = "5%";
        } else {
            const fraction = p.filesFound ? p.processed / p.filesFound : 0;
            fill.style.width = `${Math.max(5, Math.round(fraction * 100))}%`;
            label.textContent = `${p.processed} / ${p.filesFound} read  -  ${p.dicomCount} DICOM`;
        }
    });

    try {
        const result = await window.dcmsort.scanDirectory(root);
        state.root = result.root;
        state.library = result.library;
        state.selectedSeries = new Set();
        renderLibraryStage();
        applyDiscoveredRules(result.ruleFile);

        if (!result.library.studies.length) {
            $("#library-subtitle").textContent = `${root}  -  no DICOM files found`;
        }
    } catch (err) {
        $("#library-subtitle").textContent = `Scan failed: ${err.message}`;
    } finally {
        unsubscribe();
        bar.classList.add("hidden");
    }
}

/**
 * Take up a rule set found in the scanned folder. The rules cannot be applied
 * yet - they only mean something once volumes exist - so they are held until
 * the user analyses, and the series they were built from are ticked so that is
 * a single click away.
 */
function applyDiscoveredRules(found) {
    if (!found) return;

    if (found.ambiguous) {
        setLibraryMessages([
            {
                level: "info",
                message: `This folder has several rule files (${found.ambiguous.join(", ")}) and none named rules.dcmsort.json, so none was loaded. Pick one with File > Load Rule Set.`
            }
        ]);
        return;
    }

    if (found.error) {
        setLibraryMessages([
            { level: "warning", message: `Ignored ${basename(found.filePath)}: ${found.error}` }
        ]);
        return;
    }

    state.pendingRuleSet = found.ruleSet;
    state.pendingRuleFile = found.filePath;

    // The rules say nothing about where they came from, so what to tick is
    // decided by shape: the main process reports which series they fit.
    const fitting = found.fittingSeries || [];
    for (const uid of fitting) state.selectedSeries.add(uid);
    renderLibraryStage();

    setLibraryMessages([
        {
            level: "info",
            message: fitting.length
                ? `Found ${basename(found.filePath)} - ${pluralize(fitting.length, "series", "series")} here ${fitting.length === 1 ? "matches" : "match"} these rules, pre-selected. They apply when you press Analyze Selected.`
                : `Found ${basename(found.filePath)}, but no series here has the shape it needs. The rules still apply to whatever you analyze.`
        }
    ]);
}

/* ------------------------------------------------------------------ */
/* Stage B: workspace                                                  */
/* ------------------------------------------------------------------ */

async function analyzeSelected() {
    const uids = [...state.selectedSeries];
    if (!uids.length) return;

    // A rule set found in the folder carries the phase ordering it was built
    // on; adopt it before the first analysis rather than re-detecting.
    if (state.pendingRuleSet?.phaseKeyOverrides) {
        state.phaseKeyOverrides = { ...state.phaseKeyOverrides, ...state.pendingRuleSet.phaseKeyOverrides };
    }

    const analysis = await window.dcmsort.analyzeSelection(uids, state.phaseKeyOverrides);
    // Rules found alongside the folder are consumed here, requirements and
    // all, so checkRules can confirm they fit what was actually selected.
    const pending = state.pendingRuleSet;
    state.pendingRuleSet = null;

    state.analysis = analysis;
    state.ruleSet = pending ?? { version: 1, childSeries: [] };
    state.focusedChildId = state.ruleSet.childSeries[0]?.id ?? null;
    state.nextChildIndex = state.ruleSet.childSeries.length;
    state.preview = null;

    goToWorkspace();
    renderWorkspaceStructure();

    if (state.ruleSet.childSeries.length) {
        await refreshPreview();
        const problems = await window.dcmsort.checkRules(state.ruleSet);
        setMessages([
            { level: "info", message: `Rules from ${basename(state.pendingRuleFile)}` },
            ...problems.map((p) => ({ level: p.level, message: p.message })),
            ...state.messages
        ]);
    } else if (analysis.volumes.length) {
        // A useful default beats an empty canvas: one child series covering the
        // largest volume, which the user can immediately narrow.
        workspaceActions.addChild();
    } else {
        await refreshPreview();
    }
}

function goToWorkspace() {
    state.stage = "workspace";
    $("#stage-library").hidden = true;
    $("#stage-workspace").hidden = false;
}

function goToLibrary() {
    state.stage = "library";
    $("#stage-workspace").hidden = true;
    $("#stage-library").hidden = false;
    renderLibraryStage();
}

/** Rebuild everything that depends on the analysis rather than on the rules. */
function renderWorkspaceStructure() {
    const { analysis } = state;

    $("#workspace-title").textContent = analysis.series
        .map((s) => `${s.seriesNumber ?? "-"} ${s.seriesDescription}`)
        .join("   |   ");

    // The editors cache their DOM between renders; a new analysis invalidates it.
    resetRuleEditor();
    resetAttrEditor();

    renderFileList($("#file-list"), analysis.series);
    $("#file-count").textContent = fileListSummary(analysis.series);

    renderVolumePanel($("#volume-panel"), analysis.volumes, workspaceActions);
    $("#volume-summary").textContent = `${pluralize(analysis.volumes.length, "volume")} in ${pluralize(
        analysis.series.length,
        "series",
        "series"
    )}`;

    setMessages(analysis.warnings.map((message) => ({ level: "warning", message })));
}

/** Rebuild the rule and attribute panels, then repaint the claim colours. */
function renderRules() {
    renderRuleEditor($("#rule-editor"), {
        ruleSet: state.ruleSet,
        preview: state.preview,
        volumes: state.analysis?.volumes || [],
        focusedChildId: state.focusedChildId,
        actions: workspaceActions
    });
    renderAttrEditor($("#attr-editor"), {
        ruleSet: state.ruleSet,
        preview: state.preview,
        focusedChildId: state.focusedChildId,
        actions: workspaceActions,
        palette: PALETTE
    });
    paintFileList(state.preview, state.ruleSet);
    paintVolumePanel(state.preview, state.ruleSet);
}

async function refreshPreview() {
    if (!state.analysis) return;
    try {
        state.preview = await window.dcmsort.previewRules(state.ruleSet);
    } catch (err) {
        state.preview = null;
        setMessages([{ level: "error", message: err.message }]);
        return;
    }

    setMessages([
        ...state.analysis.warnings.map((message) => ({ level: "warning", message })),
        ...summarizeConflicts(state.preview.conflicts)
    ]);
    renderRules();
}

/**
 * Overlap notices arrive one per file, which would bury everything else.
 * Collapse them into a single line.
 */
function summarizeConflicts(conflicts) {
    const out = [];
    let overlaps = 0;

    for (const c of conflicts) {
        if (c.level === "info" && c.filePath) overlaps++;
        else out.push({ level: c.level, message: c.message });
    }
    if (overlaps) {
        out.push({
            level: "info",
            message: `${pluralize(overlaps, "file is", "files are")} claimed by more than one child series; each extra copy gets a new SOPInstanceUID.`
        });
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Workspace actions                                                   */
/* ------------------------------------------------------------------ */

const workspaceActions = {
    addChild(overrides = {}) {
        const index = state.nextChildIndex++;
        const biggest = [...(state.analysis?.volumes || [])].sort(
            (a, b) => b.slices * b.phases - a.slices * a.phases
        )[0];

        const child = {
            id: `cs-${index + 1}`,
            label: `Child series ${index + 1}`,
            color: paletteColor(index),
            selections: biggest ? [{ volumeId: biggest.id, slices: "*", phases: "*" }] : [],
            attributes: {
                seriesNumberMode: "scaleOffset",
                seriesScale: 100,
                seriesOffset: index + 1,
                seriesNumberAbsolute: null,
                descriptionMode: "affix",
                descriptionNew: null,
                descriptionPrefix: null,
                descriptionSuffix: null,
                stripExistingPrefix: false,
                newSeriesInstanceUID: true,
                renumberInstances: true,
                instanceOrder: "phase-major"
            },
            ...overrides
        };

        state.ruleSet.childSeries.push(child);
        state.focusedChildId = child.id;
        refreshPreview();
    },

    duplicateChild(id) {
        const source = state.ruleSet.childSeries.find((cs) => cs.id === id);
        if (!source) return;
        const index = state.nextChildIndex;
        workspaceActions.addChild({
            label: `${source.label} copy`,
            selections: source.selections.map((s) => ({ ...s })),
            attributes: { ...source.attributes, seriesOffset: (source.attributes.seriesOffset ?? 0) + 1 },
            color: paletteColor(index)
        });
    },

    removeChild(id) {
        state.ruleSet.childSeries = state.ruleSet.childSeries.filter((cs) => cs.id !== id);
        if (state.focusedChildId === id) state.focusedChildId = state.ruleSet.childSeries[0]?.id ?? null;
        refreshPreview();
    },

    focusChild(id) {
        if (state.focusedChildId === id) return;
        state.focusedChildId = id;
        renderRules();
    },

    updateChild(id, patch) {
        const child = state.ruleSet.childSeries.find((cs) => cs.id === id);
        if (!child) return;
        Object.assign(child, patch);
        refreshPreview();
    },

    updateChildAttributes(id, patch) {
        const child = state.ruleSet.childSeries.find((cs) => cs.id === id);
        if (!child) return;
        Object.assign(child.attributes, patch);
        refreshPreview();
    },

    addSelection(childId) {
        const child = state.ruleSet.childSeries.find((cs) => cs.id === childId);
        const volume = state.analysis?.volumes?.[0];
        if (!child || !volume) return;
        child.selections.push({ volumeId: volume.id, slices: "*", phases: "*" });
        state.focusedChildId = childId;
        refreshPreview();
    },

    updateSelection(childId, index, patch) {
        const child = state.ruleSet.childSeries.find((cs) => cs.id === childId);
        if (!child || !child.selections[index]) return;
        Object.assign(child.selections[index], patch);
        refreshPreview();
    },

    removeSelection(childId, index) {
        const child = state.ruleSet.childSeries.find((cs) => cs.id === childId);
        if (!child) return;
        child.selections.splice(index, 1);
        refreshPreview();
    },

    /**
     * Re-run the analysis with a different phase-ordering attribute. Rules are
     * kept: the volumes keep their ids and shapes, only the phase order within
     * them changes.
     */
    async setPhaseKey(volumeId, phaseKey) {
        state.phaseKeyOverrides[volumeId] = phaseKey;
        state.analysis = await window.dcmsort.analyzeSelection(
            [...state.selectedSeries],
            state.phaseKeyOverrides
        );
        renderWorkspaceStructure();
        await refreshPreview();
    }
};

/* ------------------------------------------------------------------ */
/* Rule set persistence                                                */
/* ------------------------------------------------------------------ */

/**
 * Adopt the phase-key overrides a rule set was saved with and re-analyze if
 * any of them differ from what is in force. Returns whether the analysis
 * changed, so the caller can rebuild the volume panel.
 */
async function restorePhaseKeys(ruleSet) {
    const saved = ruleSet.phaseKeyOverrides || {};
    const changed = Object.entries(saved).filter(([id, key]) => state.phaseKeyOverrides[id] !== key);
    if (!changed.length) return false;

    state.phaseKeyOverrides = { ...state.phaseKeyOverrides, ...saved };
    state.analysis = await window.dcmsort.analyzeSelection(
        [...state.selectedSeries],
        state.phaseKeyOverrides
    );
    return true;
}

async function saveRules() {
    const savedTo = await window.dcmsort.saveRuleSet(state.ruleSet, state.phaseKeyOverrides);
    if (savedTo) {
        setMessages([...state.messages, { level: "info", message: `Saved rules to ${savedTo}` }]);
    }
}

async function loadRules() {
    const loaded = await window.dcmsort.loadRuleSet();
    if (!loaded) return;

    state.ruleSet = loaded.ruleSet;
    state.focusedChildId = loaded.ruleSet.childSeries[0]?.id ?? null;
    // Keep generated ids from colliding with the ones we just loaded.
    state.nextChildIndex = loaded.ruleSet.childSeries.length;

    // The saved phase ordering has to come back before the preview, or the
    // rules would resolve against a different ordering than they were built on.
    if (await restorePhaseKeys(loaded.ruleSet)) renderWorkspaceStructure();

    await refreshPreview();
    if (loaded.problems.length) {
        setMessages([
            ...loaded.problems.map((p) => ({ level: p.level, message: p.message })),
            ...state.messages
        ]);
    }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function init() {
    $("#btn-choose-folder").addEventListener("click", chooseAndScan);
    $("#btn-cancel-scan").addEventListener("click", () => window.dcmsort.cancelScan());
    $("#btn-analyze").addEventListener("click", analyzeSelected);
    $("#btn-back").addEventListener("click", goToLibrary);
    $("#btn-add-child").addEventListener("click", () => workspaceActions.addChild());
    $("#btn-save-rules").addEventListener("click", saveRules);
    $("#btn-load-rules").addEventListener("click", loadRules);
    $("#btn-export").addEventListener("click", () => {
        if (!state.preview) return;
        openExportDialog({ ruleSet: state.ruleSet, preview: state.preview });
    });

    $("#chk-only-claimed").addEventListener("change", (event) => {
        setOnlyClaimed(event.target.checked);
        paintFileList(state.preview, state.ruleSet);
    });

    initExportDialog();

    window.dcmsort.onOpenPath((root) => scan(root));

    window.dcmsort.onMenuCommand((command) => {
        if (command === "open-folder") chooseAndScan();
        else if (command === "save-rules" && state.stage === "workspace") saveRules();
        else if (command === "load-rules" && state.stage === "workspace") loadRules();
        else if (command === "back-to-library" && state.stage === "workspace") goToLibrary();
        else if (command === "export" && state.stage === "workspace" && state.preview) {
            openExportDialog({ ruleSet: state.ruleSet, preview: state.preview });
        }
    });

    renderLibraryStage();
}

init();
