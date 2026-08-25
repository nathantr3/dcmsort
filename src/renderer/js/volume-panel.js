import { el, clear, pluralize } from "./dom.js";

/**
 * "Volume 1 - 58 slices x 9 phases": the analysis result, stated plainly, plus
 * a miniature slice-by-phase map that lights up as rules claim cells.
 *
 * The phase-key dropdown is deliberately visible rather than hidden behind an
 * advanced menu. When detection guesses wrong, this is the control that fixes
 * it, and the user needs to see which attribute the ordering came from.
 */

let cellsByVolume = new Map();

const FIELD_LABELS = {
    imageType: "ImageType",
    echoNumbers: "EchoNumbers",
    echoTime: "TE",
    sequenceName: "SequenceName",
    protocolName: "ProtocolName",
    scanningSequence: "ScanningSequence",
    sequenceVariant: "SequenceVariant",
    rows: "Rows",
    columns: "Columns",
    flipAngle: "FlipAngle",
    contrastBolusAgent: "Contrast"
};

function miniGrid(volume) {
    // Beyond a few hundred columns the map stops being readable and starts
    // being a performance problem, so cap what we draw and say so.
    const maxPhases = Math.min(volume.phases, 64);
    const maxSlices = Math.min(volume.slices, 64);

    const grid = el("div", {
        class: "volume-grid",
        style: { gridTemplateColumns: `repeat(${maxPhases}, 7px)` }
    });

    const cells = [];
    for (let s = 0; s < maxSlices; s++) {
        for (let p = 0; p < maxPhases; p++) {
            const cell = el("div", {
                class: "grid-cell",
                title: `slice ${s + 1}, phase ${p + 1}`
            });
            cells.push({ node: cell, slice: s + 1, phase: p + 1 });
            grid.append(cell);
        }
    }
    cellsByVolume.set(volume.id, cells);

    const truncated = volume.phases > maxPhases || volume.slices > maxSlices;
    return el("div", {}, [
        grid,
        truncated ? el("div", { class: "grid-axis", text: `showing first ${maxSlices} x ${maxPhases}` }) : null,
        el("div", { class: "grid-axis", text: "rows = slices, columns = phases" })
    ]);
}

function volumeCard(volume, actions) {
    const candidates = volume.phaseKeyCandidates || [];
    const keySelect = el(
        "select",
        {
            title: "Which DICOM attribute orders the phases",
            disabled: volume.phases < 2 || candidates.length < 2,
            on: { change: (e) => actions.setPhaseKey(volume.id, e.target.value) }
        },
        candidates.map((c) =>
            el("option", {
                value: c.id,
                text: c.score === 2 ? c.id : `${c.id} (inconsistent)`,
                selected: c.id === volume.phaseKey
            })
        )
    );

    if (!candidates.length) {
        keySelect.append(el("option", { text: volume.phaseKey, selected: true }));
    }

    return el("div", { class: "volume-card", dataset: { volumeId: volume.id } }, [
        el("h3", { text: `${volume.label}` }),
        el("div", {
            class: "volume-shape",
            text: `${pluralize(volume.slices, "slice")} x ${pluralize(volume.phases, "phase")}`
        }),
        el("div", {
            class: "volume-source",
            text: `from series ${volume.seriesNumber ?? "-"} ${volume.seriesDescription || ""} - ${pluralize(volume.fileCount, "file")}`
        }),
        (volume.distinguishers || []).length
            ? el(
                  "div",
                  { class: "volume-tags" },
                  volume.distinguishers.map((d) =>
                      el("span", { class: "tag", text: `${FIELD_LABELS[d.field] || d.field}: ${d.value}` })
                  )
              )
            : null,
        miniGrid(volume),
        el("div", { class: `volume-keys${volume.phaseKeyConfident ? "" : " low-confidence"}` }, [
            el("span", { text: "slices by" }),
            el("span", { class: "tag", text: volume.sliceKeySource }),
            el("span", { text: "phases by" }),
            keySelect
        ])
    ]);
}

export function renderVolumePanel(container, volumes, actions) {
    cellsByVolume = new Map();
    clear(container);

    if (!volumes || !volumes.length) {
        container.append(el("div", { class: "rule-editor-empty", text: "No volumes detected." }));
        return;
    }
    for (const v of volumes) container.append(volumeCard(v, actions));
}

/** Light up the cells each child series claims. */
export function paintVolumePanel(preview, ruleSet) {
    const colorById = new Map((ruleSet?.childSeries || []).map((cs) => [cs.id, cs.color]));

    // volumeId -> "slice:phase" -> list of colours.
    //
    // The colour of a cell is the child series that claimed it, which is what
    // the claims map records. Reading it off the output series a cell landed
    // in only works while those are the same thing: merging, the one output is
    // not a child series - its segments are - and every cell would come back
    // the same colour.
    const claims = new Map();
    for (const cs of preview?.childSeries || []) {
        for (const cell of cs.cells) {
            const owners = preview?.claims?.[cell.filePath] || [];
            if (!claims.has(cell.volumeId)) claims.set(cell.volumeId, new Map());
            claims
                .get(cell.volumeId)
                .set(`${cell.sliceIndex}:${cell.phaseIndex}`, owners.map((id) => colorById.get(id)).filter(Boolean));
        }
    }

    for (const [volumeId, cells] of cellsByVolume) {
        const volumeClaims = claims.get(volumeId);
        for (const { node, slice, phase } of cells) {
            const colors = volumeClaims?.get(`${slice}:${phase}`) || [];
            node.classList.toggle("claimed", colors.length > 0);
            node.classList.toggle("multi", colors.length > 1);
            node.style.setProperty("--claim-color", colors[0] || "");
        }
    }
}
