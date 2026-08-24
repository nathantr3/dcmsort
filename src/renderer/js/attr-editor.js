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

function preview(text) {
    return el("div", { class: "attr-preview" }, [el("span", { class: "arrow", text: "->" }), el("span", { text })]);
}

function seriesNumberGroup(attrs, resolved, set) {
    const isScale = attrs.seriesNumberMode !== "absolute";

    const modeSelect = el(
        "select",
        { on: { change: (e) => set({ seriesNumberMode: e.target.value }) } },
        [
            el("option", { value: "scaleOffset", text: "Scale + offset", selected: isScale }),
            el("option", { value: "absolute", text: "Absolute", selected: !isScale })
        ]
    );

    const base = resolved?.baseSeriesNumber;
    const formula = isScale
        ? `${attrs.seriesScale ?? 1} x ${base ?? 0} + ${attrs.seriesOffset ?? 0}  =  ${resolved?.seriesNumber ?? "-"}`
        : String(resolved?.seriesNumber ?? "-");

    return el("div", { class: "attr-group" }, [
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
        preview(formula)
    ]);
}

function descriptionGroup(attrs, resolved, set) {
    const isReplace = attrs.descriptionMode === "replace";

    const modeSelect = el("select", { on: { change: (e) => set({ descriptionMode: e.target.value }) } }, [
        el("option", { value: "affix", text: "Keep original", selected: !isReplace }),
        el("option", { value: "replace", text: "Replace", selected: isReplace })
    ]);

    return el("div", { class: "attr-group" }, [
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
        row("Prefix", textInput(attrs.descriptionPrefix, (v) => set({ descriptionPrefix: v }), "e.g. NOT DIAGNOSTIC:")),
        row("Suffix", textInput(attrs.descriptionSuffix, (v) => set({ descriptionSuffix: v }), "e.g. (phases 1-3)")),
        checkbox(
            "Strip this prefix if already present",
            Boolean(attrs.stripExistingPrefix),
            (v) => set({ stripExistingPrefix: v }),
            "Stops the prefix stacking up when a folder is exported more than once"
        ),
        el("div", { class: "muted small", text: `from "${resolved?.baseSeriesDescription ?? ""}"` }),
        preview(resolved?.seriesDescription || "(empty)")
    ]);
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

export function renderAttrEditor(container, { ruleSet, preview: plan, focusedChildId, actions, palette }) {
    clear(container);

    const child = ruleSet.childSeries.find((cs) => cs.id === focusedChildId);
    if (!child) {
        container.append(
            el("div", { class: "attr-editor-empty" }, [
                el("p", { text: "Select a child series to edit its attributes." })
            ])
        );
        return;
    }

    const resolved = (plan?.childSeries || []).find((cs) => cs.id === child.id);
    const set = (patch) => actions.updateChildAttributes(child.id, patch);

    container.append(
        el("div", { class: "muted small", text: `Editing ${child.label}` }),
        seriesNumberGroup(child.attributes, resolved, set),
        descriptionGroup(child.attributes, resolved, set),
        identityGroup(child.attributes, set),
        colorGroup(child, actions, palette)
    );
}
