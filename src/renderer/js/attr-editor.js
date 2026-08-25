import { el, clear, debounce } from "./dom.js";

/**
 * Attribute editor for the focused child series.
 *
 * Every control sits next to a live preview of what it produces, because a
 * formula like "scale 100, offset 1" is meaningless without seeing that it
 * turns series 4 into series 401.
 */

function row(label, ...controls) {
    return el("div", { class: "attr-row" }, [el("label", { text: label }), ...controls]);
}

function numberInput(value, onChange, title) {
    return el("input", {
        type: "number",
        value: value ?? "",
        title,
        on: { input: debounce((e) => onChange(e.target.value === "" ? null : Number(e.target.value)), 200) }
    });
}

function textInput(value, onChange, placeholder, title) {
    return el("input", {
        type: "text",
        value: value ?? "",
        placeholder: placeholder || "",
        title,
        on: { input: debounce((e) => onChange(e.target.value || null), 250) }
    });
}

function checkbox(label, checked, onChange, title) {
    return el("label", { class: "checkbox small", title }, [
        el("input", { type: "checkbox", checked, on: { change: (e) => onChange(e.target.checked) } }),
        el("span", { text: label })
    ]);
}

function preview() {
    const value = el("span");
    const node = el("div", { class: "attr-preview" }, [el("span", { class: "arrow", text: "->" }), value]);
    node._value = value;
    return node;
}

function seriesNumberGroup(attrs, set) {
    const isScale = attrs.seriesNumberMode !== "absolute";

    const modeSelect = el(
        "select",
        { on: { change: (e) => set({ seriesNumberMode: e.target.value }) } },
        [
            el("option", { value: "scaleOffset", text: "Scale + offset", selected: isScale }),
            el("option", { value: "absolute", text: "Absolute", selected: !isScale })
        ]
    );

    const numberPreview = preview();

    const group = el("div", { class: "attr-group" }, [
        el("h4", { text: "Series number" }),
        row("Mode", modeSelect),
        isScale
            ? row(
                  "Scale / offset",
                  el("div", { class: "attr-inline" }, [
                      numberInput(attrs.seriesScale, (v) => set({ seriesScale: v }), "Multiplies the source series number"),
                      numberInput(attrs.seriesOffset, (v) => set({ seriesOffset: v }), "Added after scaling")
                  ])
              )
            : row(
                  "Number",
                  numberInput(
                      attrs.seriesNumberAbsolute,
                      (v) => set({ seriesNumberAbsolute: v }),
                      "Used verbatim, ignoring the source series number"
                  )
              ),
        numberPreview
    ]);

    group._numberPreview = numberPreview;
    return group;
}

function descriptionGroup(attrs, set) {
    const isReplace = attrs.descriptionMode === "replace";

    const modeSelect = el("select", { on: { change: (e) => set({ descriptionMode: e.target.value }) } }, [
        el("option", { value: "affix", text: "Keep original", selected: !isReplace }),
        el("option", { value: "replace", text: "Replace", selected: isReplace })
    ]);

    const from = el("div", { class: "muted small" });
    const descPreview = preview();

    const group = el("div", { class: "attr-group" }, [
        el("h4", { text: "Series description" }),
        row("Mode", modeSelect),
        row(
            isReplace ? "New text" : "Label",
            textInput(
                attrs.descriptionNew,
                (v) => set({ descriptionNew: v }),
                isReplace ? "Replaces the description" : "Placed before the original",
                isReplace
                    ? "Replaces the source description entirely"
                    : "Written as 'Label: original description'"
            )
        ),
        row(
            "Strip prefix",
            textInput(
                attrs.descriptionStripPrefix,
                (v) => set({ descriptionStripPrefix: v }),
                "e.g. NOT DIAGNOSTIC:",
                "Removed from the start of the original description before anything is added. Case-insensitive, and takes a trailing colon with it."
            )
        ),
        row("Prefix", textInput(attrs.descriptionPrefix, (v) => set({ descriptionPrefix: v }), "e.g. My Feature:")),
        row("Suffix", textInput(attrs.descriptionSuffix, (v) => set({ descriptionSuffix: v }), "e.g. (phases 1-3)")),
        checkbox(
            "Also strip the prefix being added",
            Boolean(attrs.stripExistingPrefix),
            (v) => set({ stripExistingPrefix: v }),
            "Stops the prefix above stacking up when a folder is exported more than once"
        ),
        from,
        descPreview
    ]);

    group._from = from;
    group._descPreview = descPreview;
    return group;
}

function identityGroup(attrs, set) {
    return el("div", { class: "attr-group" }, [
        el("h4", { text: "Identity" }),
        checkbox(
            "New SeriesInstanceUID",
            Boolean(attrs.newSeriesInstanceUID),
            (v) => set({ newSeriesInstanceUID: v }),
            "Generates a fresh UID so viewers and PACS treat this as its own series. Turn off only to merge into an existing series."
        ),
        checkbox(
            "Renumber instances from 1",
            Boolean(attrs.renumberInstances),
            (v) => set({ renumberInstances: v }),
            "Rewrites InstanceNumber sequentially across this child series"
        ),
        row(
            "Order",
            el(
                "select",
                {
                    title: "Phase-major keeps each 3D volume contiguous; slice-major keeps each slice's time course contiguous",
                    on: { change: (e) => set({ instanceOrder: e.target.value }) }
                },
                [
                    el("option", {
                        value: "phase-major",
                        text: "Phase-major (volume by volume)",
                        selected: attrs.instanceOrder !== "slice-major"
                    }),
                    el("option", {
                        value: "slice-major",
                        text: "Slice-major (slice by slice)",
                        selected: attrs.instanceOrder === "slice-major"
                    })
                ]
            )
        )
    ]);
}

function colorGroup(child, actions, palette) {
    return el("div", { class: "attr-group" }, [
        el("h4", { text: "Colour" }),
        el(
            "div",
            { class: "volume-tags" },
            palette.map((color) =>
                el("button", {
                    class: "swatch",
                    title: color,
                    style: {
                        background: color,
                        width: "18px",
                        height: "18px",
                        borderColor: color === child.color ? "var(--text-bright)" : "transparent"
                    },
                    on: { click: () => actions.updateChild(child.id, { color }) }
                })
            )
        )
    ]);
}

/**
 * As in the rule editor, rebuilding the panel would steal focus from whichever
 * field is being typed into. The DOM is rebuilt only when the set of controls
 * actually changes - a different child series, or a mode switch that swaps one
 * row for another - and the live previews are patched in place otherwise.
 */
function structureKey(child) {
    if (!child) return "none";
    const { seriesNumberMode, descriptionMode } = child.attributes;
    return `${child.id}:${seriesNumberMode}:${descriptionMode}:${child.color}`;
}

let groups = null;
let lastKey = null;

function patch(child, resolved) {
    if (!groups) return;

    const attrs = child.attributes;
    const isScale = attrs.seriesNumberMode !== "absolute";
    groups.number._numberPreview._value.textContent = isScale
        ? `${attrs.seriesScale ?? 1} x ${resolved?.baseSeriesNumber ?? 0} + ${attrs.seriesOffset ?? 0}  =  ${resolved?.seriesNumber ?? "-"}`
        : String(resolved?.seriesNumber ?? "-");

    groups.description._from.textContent = `from "${resolved?.baseSeriesDescription ?? ""}"`;
    groups.description._descPreview._value.textContent = resolved?.seriesDescription || "(empty)";
    groups.heading.textContent = `Editing ${child.label}`;
}

export function renderAttrEditor(container, { ruleSet, preview: plan, focusedChildId, actions, palette, merging }) {
    const child = ruleSet.childSeries.find((cs) => cs.id === focusedChildId);
    const key = `${structureKey(child)}:${merging ? "merge" : "split"}`;
    // Merging writes one series, whose values come from the merged output
    // rather than from whichever segment happens to be focused.
    const resolved = merging
        ? plan?.childSeries?.[0]
        : child && (plan?.childSeries || []).find((cs) => cs.id === child.id);

    if (key === lastKey && container.childElementCount) {
        patch(child, resolved);
        return;
    }
    lastKey = key;
    groups = null;
    clear(container);

    if (!child) {
        container.append(
            el("div", { class: "attr-editor-empty" }, [
                el("p", { text: "Select a child series to edit its attributes." })
            ])
        );
        return;
    }

    // The segments are held identical while merging, so say so rather than
    // letting it look as though this panel edits one of them.
    const mergeNote = merging
        ? el("div", {
              class: "attr-merge-note small",
              text: "These apply to the whole merged series - every segment shares them."
          })
        : null;

    const set = (patchAttrs) => actions.updateChildAttributes(child.id, patchAttrs);
    const heading = el("div", { class: "muted small" });
    const number = seriesNumberGroup(child.attributes, set);
    const description = descriptionGroup(child.attributes, set);

    container.append(
        ...(mergeNote ? [mergeNote] : []),
        heading,
        number,
        description,
        identityGroup(child.attributes, set),
        colorGroup(child, actions, palette)
    );

    groups = { heading, number, description };
    patch(child, resolved);
}

/** Drop cached nodes so the next render rebuilds from scratch. */
export function resetAttrEditor() {
    groups = null;
    lastKey = null;
}
