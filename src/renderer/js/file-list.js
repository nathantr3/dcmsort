import { el, clear, pluralize } from "./dom.js";

/**
 * The left sidebar: every file of every selected series, grouped and
 * collapsible like an editor's explorer.
 *
 * Structure is built once per analysis and then only repainted, because the
 * colour feedback has to keep up with typing in the rule editor and a series
 * can easily run to thousands of rows.
 */

const collapsedGroups = new Set();

let rowsByPath = new Map();
let currentSeries = [];
let onlyClaimed = false;

function swatchStyle(colors) {
    if (!colors.length) return {};
    if (colors.length === 1) return { background: colors[0], borderColor: "transparent" };

    // Hard-edged stripes, so an overlapping claim reads as "several" rather
    // than as some blended third colour.
    const step = 100 / colors.length;
    const stops = colors
        .map((c, i) => `${c} ${(i * step).toFixed(2)}%, ${c} ${((i + 1) * step).toFixed(2)}%`)
        .join(", ");
    return { background: `linear-gradient(135deg, ${stops})`, borderColor: "transparent" };
}

function fileRow(file) {
    const swatch = el("span", { class: "swatch" });
    const coords = el("span", { class: "file-coords" });

    const row = el("div", { class: "file-row", title: file.filePath }, [
        swatch,
        el("span", { class: "file-name", text: file.name }),
        coords
    ]);

    row._swatch = swatch;
    row._coords = coords;
    return row;
}

function group(series) {
    const key = series.seriesInstanceUID;
    const isCollapsed = collapsedGroups.has(key);

    const rows = el("div", { class: "file-group-rows", hidden: isCollapsed });
    for (const file of series.files) {
        const row = fileRow(file);
        rowsByPath.set(file.filePath, row);
        rows.append(row);
    }

    const twisty = el("span", { class: `twisty${isCollapsed ? " collapsed" : ""}`, text: "▾" });
    const header = el(
        "div",
        {
            class: "file-group-header",
            on: {
                click: () => {
                    const nowCollapsed = !rows.hidden;
                    rows.hidden = nowCollapsed;
                    twisty.classList.toggle("collapsed", nowCollapsed);
                    if (nowCollapsed) collapsedGroups.add(key);
                    else collapsedGroups.delete(key);
                }
            }
        },
        [
            twisty,
            el("span", {
                class: "file-group-name",
                text: `${series.seriesNumber ?? "-"}  ${series.seriesDescription}`,
                title: series.seriesDescription
            }),
            el("span", { class: "file-group-count", text: series.files.length })
        ]
    );

    return el("div", { class: "file-group" }, [header, rows]);
}

/** Rebuild the list. Call once per analysis. */
export function renderFileList(container, series) {
    currentSeries = series || [];
    rowsByPath = new Map();
    clear(container);

    if (!currentSeries.length) {
        container.append(el("div", { class: "file-list-empty", text: "No series selected." }));
        return;
    }
    for (const s of currentSeries) container.append(group(s));
}

/**
 * Repaint claim colours from a preview. Cheap: touches only the swatch style
 * and one class per row.
 */
export function paintFileList(preview, ruleSet) {
    const colorById = new Map((ruleSet?.childSeries || []).map((cs) => [cs.id, cs.color]));
    const coordsByPath = new Map();

    for (const cs of preview?.childSeries || []) {
        for (const cell of cs.cells) coordsByPath.set(cell.filePath, cell);
    }

    for (const [filePath, row] of rowsByPath) {
        const owners = preview?.claims?.[filePath] || [];
        const colors = owners.map((id) => colorById.get(id)).filter(Boolean);

        row.classList.toggle("claimed", owners.length > 0);
        row._swatch.classList.toggle("claimed", owners.length > 0);
        Object.assign(row._swatch.style, { background: "", borderColor: "" }, swatchStyle(colors));
        row._swatch.title = owners.length
            ? owners.map((id) => labelFor(ruleSet, id)).join(", ")
            : "Not claimed by any rule";

        const cell = coordsByPath.get(filePath);
        row._coords.textContent = cell ? `s${cell.sliceIndex} p${cell.phaseIndex}` : "";
        row.hidden = onlyClaimed && owners.length === 0;
    }

    updateGroupVisibility();
}

function labelFor(ruleSet, id) {
    return ruleSet?.childSeries?.find((cs) => cs.id === id)?.label || id;
}

/** Hide a group header once the filter has hidden all of its rows. */
function updateGroupVisibility() {
    for (const groupNode of document.querySelectorAll(".file-group")) {
        const rows = [...groupNode.querySelectorAll(".file-row")];
        const visible = rows.filter((r) => !r.hidden).length;
        groupNode.hidden = onlyClaimed && visible === 0;
        const count = groupNode.querySelector(".file-group-count");
        if (count) count.textContent = onlyClaimed ? `${visible}/${rows.length}` : String(rows.length);
    }
}

export function setOnlyClaimed(value) {
    onlyClaimed = value;
}

export function fileListSummary(series) {
    const total = (series || []).reduce((n, s) => n + s.files.length, 0);
    return `${pluralize(total, "file")} in ${pluralize((series || []).length, "series", "series")}`;
}
