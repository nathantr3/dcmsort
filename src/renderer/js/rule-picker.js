import { el, clear, $, pluralize } from "./dom.js";

/**
 * Picks between the rule sets found in a folder.
 *
 * Which rules to apply is not something to guess at, so when a folder holds
 * more than one usable rule file the choice is put to the user at the moment
 * it matters - on Analyze, once there is a selection for the summaries to be
 * measured against.
 */

const overlay = $("#rule-picker-overlay");
const summary = $("#rule-picker-summary");
const list = $("#rule-picker-list");
const useButton = $("#btn-rule-picker-use");
const cancelButton = $("#btn-rule-picker-cancel");

/** Resolver for the promise `openRulePicker` handed back, while one is open. */
let settle = null;
let choices = [];

/** "v1 exactly 4 phases, v2 at least 3 slices", or the shape-free case. */
function requirementLine(summaryOf) {
    const requires = summaryOf.requires;
    if (!requires) return "Applies to any shape";

    const parts = [];
    if (Number.isFinite(requires.volumeCount)) parts.push(pluralize(requires.volumeCount, "volume"));
    for (const volume of requires.volumes) parts.push(`${volume.id} ${volume.needs.join(", ")}`);
    return parts.length ? `Needs ${parts.join(" · ")}` : "Applies to any shape";
}

function outputLines(summaryOf) {
    return summaryOf.childSeries.map((cs) =>
        el("div", { class: "rule-option-line" }, [
            el("span", { class: "rule-option-arrow", text: "→" }),
            `${cs.label}: ${cs.seriesNumber}, ${cs.description}`,
            cs.selections.length ? el("span", { class: "muted", text: `  (${cs.selections.join("; ")})` }) : null
        ])
    );
}

/**
 * Which of the folder's series this rule set fits, named rather than counted -
 * that is the fact the choice usually turns on.
 */
function matchLine(candidate, seriesLabels) {
    const fitting = candidate.fittingSeries || [];
    if (!fitting.length) return el("div", { class: "rule-option-line warn", text: "Matches no series in this folder" });

    const named = fitting.map((uid) => seriesLabels.get(uid) || uid);
    const shown = named.slice(0, 3).join(", ");
    return el("div", {
        class: "rule-option-line ok",
        text: `Matches ${pluralize(fitting.length, "series", "series")}: ${shown}${named.length > 3 ? ", ..." : ""}`
    });
}

function option({ value, title, subtitle, body, checked }) {
    return el("label", { class: "rule-option" }, [
        el("input", { type: "radio", name: "rule-choice", value, checked, on: { change: refresh } }),
        el("div", { class: "rule-option-body" }, [
            el("div", { class: "rule-option-title" }, [
                el("strong", { text: title }),
                subtitle ? el("span", { class: "muted", text: subtitle }) : null
            ]),
            ...body
        ])
    ]);
}

function selectedValue() {
    return $('input[name="rule-choice"]:checked', list)?.value ?? null;
}

function refresh() {
    useButton.disabled = selectedValue() === null;
}

function close(result) {
    overlay.hidden = true;
    const done = settle;
    settle = null;
    choices = [];
    done?.(result);
}

/**
 * @param {object[]} candidates from the scan, each with ruleSet, summary and fittingSeries
 * @param {Map<string, string>} seriesLabels SeriesInstanceUID -> "4 MULTI RECON"
 * @returns {Promise<object|null>} the chosen candidate, null to carry on with
 *          no rules, or undefined when the user backed out entirely
 */
export function openRulePicker(candidates, seriesLabels) {
    choices = candidates;
    summary.textContent =
        `This folder holds ${pluralize(candidates.length, "rule set")}. ` +
        `Choose the one to apply to the series you selected.`;

    clear(list);
    candidates.forEach((candidate, index) => {
        list.append(
            option({
                value: String(index),
                title: candidate.relativePath,
                subtitle: null,
                checked: index === 0,
                body: [
                    el("div", { class: "rule-option-line", text: requirementLine(candidate.summary) }),
                    ...outputLines(candidate.summary),
                    matchLine(candidate, seriesLabels)
                ]
            })
        );
    });

    // Finding rule files should never trap the user into using one.
    list.append(
        option({
            value: "none",
            title: "Without a rule set",
            subtitle: "start from a blank workspace",
            checked: false,
            body: []
        })
    );

    refresh();
    overlay.hidden = false;
    useButton.focus();

    return new Promise((resolve) => {
        settle = resolve;
    });
}

export function initRulePicker() {
    useButton.addEventListener("click", () => {
        const value = selectedValue();
        close(value === "none" ? null : choices[Number(value)]);
    });
    cancelButton.addEventListener("click", () => close(undefined));

    // Escape backs out, like the rest of the app's dialogs.
    overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") close(undefined);
    });
}
