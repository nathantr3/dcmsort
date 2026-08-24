import { el, clear, debounce, pluralize } from "./dom.js";

/**
 * The rule builder.
 *
 * Each selection renders as a sentence with editable slots -
 *   FROM [Volume 1] SELECT slices [*] AND phases [1-3]
 * - which is the whole point: the query language is visible and learnable, but
 * nobody has to type it as text.
 */

/** Mirrors PALETTE in src/main/rules.js; keep the two in step. */
export const PALETTE = [
    "#4EC9B0", "#569CD6", "#C586C0", "#DCDCAA",
    "#CE9178", "#9CDCFE", "#B5CEA8", "#D16969",
    "#4FC1FF", "#E9A66C", "#7FB3D5", "#F2A2C0"
];

export function paletteColor(index) {
    return PALETTE[index % PALETTE.length];
}

const RANGE_HINT = "* = all, 1-3 = a range, 1,3,5 = a list, 1-9:2 = every other, -1 = last";

function selectionRow({ selection, index, childId, volumes, resolvedCount, actions }) {
    const volume = volumes.find((v) => v.id === selection.volumeId);

    const volumeSelect = el(
        "select",
        {
            title: "Source volume",
            on: { change: (e) => actions.updateSelection(childId, index, { volumeId: e.target.value }) }
        },
        volumes.map((v) =>
            el("option", {
                value: v.id,
                text: `${v.label} (${v.slices}x${v.phases})`,
                selected: v.id === selection.volumeId
            })
        )
    );

    const rangeInput = (field, value, max) =>
        el("input", {
            type: "text",
            class: "range",
            value: value ?? "*",
            title: `${RANGE_HINT}\nThis axis has ${max}.`,
            on: {
                input: debounce((e) => actions.updateSelection(childId, index, { [field]: e.target.value }), 200)
            }
        });

    return el("div", { class: "selection-row" }, [
        el("span", { class: "kw", text: "FROM" }),
        volumeSelect,
        el("span", { class: "kw", text: "SELECT slices" }),
        rangeInput("slices", selection.slices, volume?.slices ?? 0),
        el("span", { class: "kw", text: "AND phases" }),
        rangeInput("phases", selection.phases, volume?.phases ?? 0),
        el("span", { class: "selection-count", text: resolvedCount === null ? "" : `${resolvedCount} files` }),
        el("button", {
            class: "ghost small",
            text: "x",
            title: "Remove this selection",
            on: { click: () => actions.removeSelection(childId, index) }
        })
    ]);
}

function childCard({ child, resolved, volumes, focused, actions }) {
    const head = el(
        "div",
        {
            class: "child-head",
            on: {
                click: (event) => {
                    if (event.target.tagName === "INPUT" || event.target.tagName === "BUTTON") return;
                    actions.focusChild(child.id);
                }
            }
        },
        [
            el("span", { class: "child-swatch" }),
            el("input", {
                class: "child-label-input",
                type: "text",
                value: child.label,
                title: "Name for this child series (used in the UI only)",
                on: {
                    input: debounce((e) => actions.updateChild(child.id, { label: e.target.value }), 250),
                    focus: () => actions.focusChild(child.id)
                }
            }),
            el("span", { class: "child-preview" }, [
                resolved
                    ? el("span", {}, [
                          el("strong", { text: String(resolved.seriesNumber ?? "-") }),
                          document.createTextNode(`  ${resolved.seriesDescription || ""}  -  `),
                          document.createTextNode(pluralize(resolved.fileCount, "file"))
                      ])
                    : document.createTextNode("no files")
            ]),
            el("span", { class: "spacer" }),
            el("button", {
                class: "ghost small",
                text: "Duplicate",
                on: { click: () => actions.duplicateChild(child.id) }
            }),
            el("button", {
                class: "danger small",
                text: "Delete",
                on: { click: () => actions.removeChild(child.id) }
            })
        ]
    );

    const countsBySelection = resolved?.selectionCounts || [];

    const body = el("div", { class: "child-body" }, [
        ...child.selections.map((selection, i) =>
            selectionRow({
                selection,
                index: i,
                childId: child.id,
                volumes,
                resolvedCount: countsBySelection[i] ?? null,
                actions
            })
        ),
        child.selections.length
            ? null
            : el("div", { class: "muted small", text: "No selections yet - add one to choose images." }),
        el("div", { class: "child-actions" }, [
            el("button", {
                class: "ghost small",
                text: "+ Add selection",
                disabled: !volumes.length,
                on: { click: () => actions.addSelection(child.id) }
            })
        ])
    ]);

    return el(
        "div",
        {
            class: `child-card${focused ? " focused" : ""}`,
            style: { "--child-color": child.color },
            dataset: { childId: child.id }
        },
        [head, body]
    );
}

export function renderRuleEditor(container, { ruleSet, preview, volumes, focusedChildId, actions }) {
    clear(container);

    if (!ruleSet.childSeries.length) {
        container.append(
            el("div", { class: "rule-editor-empty" }, [
                el("p", { text: "No child series defined." }),
                el("p", {
                    class: "small",
                    text: "A child series is one output series: pick the slices and phases it takes, then set its number and description."
                }),
                el("button", {
                    class: "primary",
                    text: "+ Add child series",
                    disabled: !volumes.length,
                    on: { click: () => actions.addChild() }
                })
            ])
        );
        return;
    }

    const resolvedById = new Map((preview?.childSeries || []).map((cs) => [cs.id, cs]));

    for (const child of ruleSet.childSeries) {
        container.append(
            childCard({
                child,
                resolved: resolvedById.get(child.id),
                volumes,
                focused: child.id === focusedChildId,
                actions
            })
        );
    }
}
