import { el, clear, $, pluralize } from "./dom.js";

/**
 * Export dialog. In-place writing is destructive and irreversible, so it is
 * never the default and needs an explicit acknowledgement before it will run.
 */

const overlay = $("#export-overlay");
const summary = $("#export-summary");
const folderInput = $("#export-folder");
const folderRow = $("#export-folder-row");
const inplaceConfirmRow = $("#inplace-confirm-row");
const inplaceConfirm = $("#chk-inplace-confirm");
const progress = $("#export-progress");
const resultBox = $("#export-result");
const runButton = $("#btn-export-run");
const cancelButton = $("#btn-export-cancel");

let context = null;
let outputDir = null;
let running = false;

function selectedMode() {
    return document.querySelector('input[name="export-mode"]:checked').value;
}

function refresh() {
    const mode = selectedMode();
    folderRow.classList.toggle("hidden", mode !== "new-folder");
    inplaceConfirmRow.classList.toggle("hidden", mode !== "in-place");

    const ready =
        !running && (mode === "new-folder" ? Boolean(outputDir) : inplaceConfirm.checked);
    runButton.disabled = !ready;
    runButton.textContent = mode === "in-place" ? "Overwrite sources" : "Export";
    runButton.classList.toggle("danger", mode === "in-place");
}

function setProgress(fraction, label) {
    progress.classList.remove("hidden");
    progress.querySelector(".progress-fill").style.width = `${Math.round(fraction * 100)}%`;
    progress.querySelector(".progress-label").textContent = label;
}

function renderSummary(preview, ruleSet) {
    clear(summary);
    const active = (preview?.childSeries || []).filter((cs) => cs.fileCount > 0);
    const total = active.reduce((n, cs) => n + cs.fileCount, 0);

    if (!active.length) {
        summary.append(el("div", { class: "warn", text: "No child series matches any files." }));
        return;
    }

    summary.append(
        el("div", { text: `${pluralize(active.length, "output series", "output series")}, ${pluralize(total, "file")}` })
    );
    for (const cs of active) {
        const color = ruleSet.childSeries.find((c) => c.id === cs.id)?.color;
        summary.append(
            el("div", {}, [
                el("span", { class: "swatch claimed", style: { background: color, display: "inline-block", marginRight: "6px" } }),
                el("strong", { text: String(cs.seriesNumber ?? "-") }),
                document.createTextNode(`  ${cs.seriesDescription || ""}  -  ${pluralize(cs.fileCount, "file")}`)
            ])
        );
    }

    const unclaimed = preview.unclaimedPaths?.length || 0;
    if (unclaimed) {
        summary.append(
            el("div", { class: "muted", text: `${pluralize(unclaimed, "file")} not claimed by any rule will not be written.` })
        );
    }
}

function renderResult(result) {
    resultBox.classList.remove("hidden");
    clear(resultBox);

    if (result.blocked) {
        resultBox.append(el("div", { class: "error", text: "Export blocked by rule errors:" }));
        for (const c of result.conflicts) resultBox.append(el("div", { class: "error small", text: c.message }));
        return;
    }

    const { stats } = result;
    resultBox.append(
        el("div", {
            class: stats.errorCount ? "warn" : "",
            text: `Wrote ${pluralize(stats.writtenCount, "file")} in ${(stats.durationMs / 1000).toFixed(1)}s${
                stats.errorCount ? `, ${pluralize(stats.errorCount, "failure")}` : ""
            }.`
        })
    );

    for (const err of (result.errors || []).slice(0, 20)) {
        resultBox.append(el("div", { class: "error small", text: `${err.filePath}: ${err.message}` }));
    }

    const firstOutput = result.written?.[0]?.outPath;
    if (firstOutput) {
        resultBox.append(
            el("button", {
                class: "ghost small",
                text: "Reveal in Finder",
                on: { click: () => window.dcmsort.revealPath(firstOutput) }
            })
        );
    }
}

export function openExportDialog(ctx) {
    context = ctx;
    running = false;
    resultBox.classList.add("hidden");
    progress.classList.add("hidden");
    inplaceConfirm.checked = false;
    cancelButton.textContent = "Cancel";

    renderSummary(ctx.preview, ctx.ruleSet);
    refresh();
    overlay.hidden = false;
}

function close() {
    overlay.hidden = true;
    context = null;
}

async function run() {
    const mode = selectedMode();
    running = true;
    refresh();
    resultBox.classList.add("hidden");
    setProgress(0, "Starting...");

    const unsubscribe = window.dcmsort.onExportProgress((p) => {
        setProgress(p.totalFiles ? p.processed / p.totalFiles : 0, `${p.processed} / ${p.totalFiles}  ${p.currentChildSeries || ""}`);
    });

    try {
        const result = await window.dcmsort.exportRules(context.ruleSet, { mode, outputDir });
        renderResult(result);
        if (!result.blocked) {
            setProgress(1, "Done");
            cancelButton.textContent = "Close";
            context.onFinished?.(result);
        }
    } catch (err) {
        resultBox.classList.remove("hidden");
        clear(resultBox);
        resultBox.append(el("div", { class: "error", text: err.message }));
    } finally {
        unsubscribe();
        running = false;
        refresh();
    }
}

export function initExportDialog() {
    for (const radio of document.querySelectorAll('input[name="export-mode"]')) {
        radio.addEventListener("change", refresh);
    }
    inplaceConfirm.addEventListener("change", refresh);

    $("#btn-choose-export-folder").addEventListener("click", async () => {
        const chosen = await window.dcmsort.chooseDirectory("Choose an output folder");
        if (chosen) {
            outputDir = chosen;
            folderInput.value = chosen;
        }
        refresh();
    });

    runButton.addEventListener("click", run);
    cancelButton.addEventListener("click", () => {
        if (running) window.dcmsort.cancelExport();
        else close();
    });

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay && !running) close();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !overlay.hidden && !running) close();
    });
}
