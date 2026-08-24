import { el, clear, pluralize } from "./dom.js";

/**
 * Stage A: the Exam > Series tree.
 *
 * Studies collapse; series are the selectable unit, because that is what the
 * workspace analyzes. Selection state lives in app.js and is passed in.
 */

const collapsedStudies = new Set();

function seriesRow(series, selected, onToggleSeries) {
    const isSelected = selected.has(series.seriesInstanceUID);

    return el(
        "div",
        {
            class: `series-row${isSelected ? " selected" : ""}`,
            on: {
                click: (event) => {
                    // Let the checkbox handle its own clicks rather than
                    // double-toggling through the row.
                    if (event.target.tagName !== "INPUT") onToggleSeries(series.seriesInstanceUID);
                }
            }
        },
        [
            el("input", {
                type: "checkbox",
                checked: isSelected,
                on: { change: () => onToggleSeries(series.seriesInstanceUID) }
            }),
            el("span", { class: "series-number", text: series.seriesNumber ?? "-" }),
            el("span", {
                class: "series-desc",
                text: series.seriesDescription,
                title: `${series.seriesDescription}\n${series.directories.join("\n")}`
            }),
            el("span", {
                class: "series-count",
                text: `${series.modality ? `${series.modality} - ` : ""}${pluralize(series.fileCount, "image")}`
            })
        ]
    );
}

function studyBlock(study, selected, actions, rerender) {
    const isCollapsed = collapsedStudies.has(study.studyInstanceUID);
    const allUIDs = study.series.map((s) => s.seriesInstanceUID);
    const allSelected = allUIDs.every((uid) => selected.has(uid));

    const header = el(
        "div",
        {
            class: "study-header",
            on: {
                click: (event) => {
                    if (event.target.tagName === "BUTTON") return;
                    if (isCollapsed) collapsedStudies.delete(study.studyInstanceUID);
                    else collapsedStudies.add(study.studyInstanceUID);
                    rerender();
                }
            }
        },
        [
            el("span", { class: `twisty${isCollapsed ? " collapsed" : ""}`, text: "▾" }),
            el("span", { class: "study-name", text: study.patientName }),
            el("span", {
                class: "study-meta",
                text: [study.studyDescription, study.studyDate, study.patientID].filter(Boolean).join("  -  ")
            }),
            el("span", { class: "spacer" }),
            el("span", { class: "study-meta", text: pluralize(study.series.length, "series", "series") }),
            el("button", {
                class: "ghost small",
                text: allSelected ? "Deselect all" : "Select all",
                on: { click: () => actions.setSeriesSelection(allUIDs, !allSelected) }
            })
        ]
    );

    const rows = el(
        "div",
        { class: "series-rows", hidden: isCollapsed },
        study.series.map((s) => seriesRow(s, selected, actions.toggleSeries))
    );

    return el("div", { class: "study" }, [header, rows]);
}

export function renderLibrary(container, library, selected, actions) {
    const rerender = () => renderLibrary(container, library, selected, actions);
    clear(container);

    if (!library || !library.studies.length) {
        container.append(el("p", { class: "muted", text: "No DICOM files were found in that folder." }));
        return;
    }

    for (const study of library.studies) {
        container.append(studyBlock(study, selected, actions, rerender));
    }
}
