"use strict";

/**
 * Synthesizes small DICOM files covering the structural cases analyze.js must
 * handle. Everything is fabricated, so the suite carries no PHI.
 *
 *   node test/fixtures/generate.js [outDir]
 */

const fs = require("fs");
const path = require("path");
const dcmjs = require("dcmjs");

const { DicomDict, DicomMetaDictionary } = dcmjs.data;

const EXPLICIT_LITTLE_ENDIAN = "1.2.840.10008.1.2.1";
const MR_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.4";

const ROWS = 4;
const COLS = 4;

let uidCounter = 0;
/** Deterministic UIDs so fixtures are byte-stable across regenerations. */
function fixedUID(suffix) {
    return `1.2.826.0.1.3680043.9.7133.${suffix}`;
}
function nextSopUID() {
    return fixedUID(`1.${++uidCounter}`);
}

function pixelData(seed) {
    const arr = new Uint16Array(ROWS * COLS);
    for (let i = 0; i < arr.length; i++) arr[i] = (seed * 37 + i * 11) % 4096;
    return arr.buffer;
}

function buildFile(natural, seed) {
    const dict = new DicomDict({
        "00020001": { vr: "OB", Value: [new Uint8Array([0, 1]).buffer] },
        "00020002": { vr: "UI", Value: [MR_IMAGE_STORAGE] },
        "00020003": { vr: "UI", Value: [natural.SOPInstanceUID] },
        "00020010": { vr: "UI", Value: [EXPLICIT_LITTLE_ENDIAN] },
        "00020012": { vr: "UI", Value: [fixedUID("0.1")] },
        "00020013": { vr: "SH", Value: ["DCMSORT_FIXTURE"] }
    });
    dict.dict = DicomMetaDictionary.denaturalizeDataset({
        SpecificCharacterSet: "ISO_IR 100",
        ImageType: ["ORIGINAL", "PRIMARY", "M", "FFE"],
        SOPClassUID: MR_IMAGE_STORAGE,
        Modality: "MR",
        Manufacturer: "DCMSORT",
        Rows: ROWS,
        Columns: COLS,
        BitsAllocated: 16,
        BitsStored: 12,
        HighBit: 11,
        PixelRepresentation: 0,
        SamplesPerPixel: 1,
        PhotometricInterpretation: "MONOCHROME2",
        PixelSpacing: [1.0, 1.0],
        SliceThickness: 5.0,
        ...natural
    });
    // PixelData has VR "ox" in the dictionary (OB or OW depending on syntax),
    // which denaturalizeDataset cannot resolve on its own.
    dict.dict["7FE00010"] = { vr: "OW", Value: [pixelData(seed)] };
    return dict;
}

/** One study-level context shared by every series in a fixture study. */
function study(name, id, uidSuffix, description) {
    return {
        PatientName: name,
        PatientID: id,
        StudyInstanceUID: fixedUID(uidSuffix),
        StudyDescription: description,
        StudyDate: "20250101",
        StudyTime: "120000",
        AccessionNumber: "ACC" + id
    };
}

/**
 * Emit a stack. `phaseTag` chooses which attribute carries the phase index,
 * which is exactly the variable analyze.js has to cope with.
 */
function stack({
    ctx,
    seriesUID,
    seriesNumber,
    seriesDescription,
    slices,
    phases,
    firstZ = 0,
    spacing = 5,
    imageType = ["ORIGINAL", "PRIMARY", "M", "FFE"],
    phaseTag = "TemporalPositionIdentifier",
    orientation = [1, 0, 0, 0, 1, 0],
    includePosition = true,
    instanceStart = 1,
    sliceMajor = true,
    extra = {}
}) {
    const files = [];
    let instance = instanceStart;

    const emit = (s, p) => {
        const z = firstZ + s * spacing;
        const natural = {
            ...ctx,
            SeriesInstanceUID: seriesUID,
            SeriesNumber: seriesNumber,
            SeriesDescription: seriesDescription,
            SOPInstanceUID: nextSopUID(),
            InstanceNumber: instance,
            ImageType: imageType,
            AcquisitionNumber: 1,
            ...extra
        };
        if (includePosition) {
            natural.ImagePositionPatient = [0, 0, z];
            natural.ImageOrientationPatient = orientation;
        }
        natural.SliceLocation = z;

        if (phases > 1 || phaseTag === "TriggerTime") {
            if (phaseTag === "TemporalPositionIdentifier") {
                natural.TemporalPositionIdentifier = p + 1;
                natural.NumberOfTemporalPositions = phases;
            } else if (phaseTag === "TriggerTime") {
                natural.TriggerTime = p * 100;
            } else if (phaseTag === "AcquisitionNumber") {
                natural.AcquisitionNumber = p + 1;
            } else if (phaseTag === "EchoTime") {
                natural.EchoTime = 2.3 + p * 1.7;
                natural.EchoNumbers = p + 1;
            }
            // phaseTag === "none" leaves every temporal tag unset, forcing the
            // InstanceNumber positional fallback.
        }

        files.push({ name: `IM-${String(instance).padStart(5, "0")}.dcm`, dict: buildFile(natural, instance) });
        instance++;
    };

    if (sliceMajor) {
        for (let s = 0; s < slices; s++) for (let p = 0; p < phases; p++) emit(s, p);
    } else {
        for (let p = 0; p < phases; p++) for (let s = 0; s < slices; s++) emit(s, p);
    }
    return files;
}

function write(dir, files) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
        fs.writeFileSync(path.join(dir, f.name), Buffer.from(f.dict.write({ allowInvalidVRLength: true })));
    }
}

function generate(outDir) {
    fs.rmSync(outDir, { recursive: true, force: true });

    const ctxA = study("DOE^JANE", "P001", "10.1", "CARDIAC MR");
    const ctxB = study("ROE^RICHARD", "P002", "10.2", "ABDOMEN MR");

    // (a) Clean 8 slices x 4 phases, phases in TemporalPositionIdentifier.
    write(
        path.join(outDir, "studyA", "series3"),
        stack({
            ctx: ctxA,
            seriesUID: fixedUID("20.3"),
            seriesNumber: 3,
            seriesDescription: "CINE SA",
            slices: 8,
            phases: 4
        })
    );

    // (b) One series holding three co-located cohorts that differ only by
    //     ImageType: 4-phase magnitude, 2-phase phase-contrast, 1 derived map.
    const mixed = [
        ...stack({
            ctx: ctxA,
            seriesUID: fixedUID("20.4"),
            seriesNumber: 4,
            seriesDescription: "MULTI RECON",
            slices: 8,
            phases: 4,
            imageType: ["ORIGINAL", "PRIMARY", "M", "FFE"],
            instanceStart: 1
        }),
        ...stack({
            ctx: ctxA,
            seriesUID: fixedUID("20.4"),
            seriesNumber: 4,
            seriesDescription: "MULTI RECON",
            slices: 8,
            phases: 2,
            imageType: ["ORIGINAL", "PRIMARY", "P", "FFE"],
            instanceStart: 100
        }),
        ...stack({
            ctx: ctxA,
            seriesUID: fixedUID("20.4"),
            seriesNumber: 4,
            seriesDescription: "MULTI RECON",
            slices: 8,
            phases: 1,
            imageType: ["DERIVED", "PRIMARY", "PDFF", "FFE"],
            instanceStart: 200
        })
    ];
    write(path.join(outDir, "studyA", "series4"), mixed);

    // (c) Ragged: same cohort signature, but the first 4 positions were imaged
    //     3 times and the next 4 only twice. Must split into two volumes.
    const ragged = [
        ...stack({
            ctx: ctxA,
            seriesUID: fixedUID("20.5"),
            seriesNumber: 5,
            seriesDescription: "RAGGED",
            slices: 4,
            phases: 3,
            firstZ: 0,
            instanceStart: 1
        }),
        ...stack({
            ctx: ctxA,
            seriesUID: fixedUID("20.5"),
            seriesNumber: 5,
            seriesDescription: "RAGGED",
            slices: 4,
            phases: 2,
            firstZ: 20,
            instanceStart: 100
        })
    ];
    write(path.join(outDir, "studyA", "series5"), ragged);

    // (d) No TemporalPositionIdentifier — phase order must fall back to TriggerTime.
    write(
        path.join(outDir, "studyB", "series2"),
        stack({
            ctx: ctxB,
            seriesUID: fixedUID("30.2"),
            seriesNumber: 2,
            seriesDescription: "DYN TRIGGER",
            slices: 6,
            phases: 3,
            phaseTag: "TriggerTime"
        })
    );

    // (e) No geometry at all and no temporal tag: SliceLocation + InstanceNumber only.
    write(
        path.join(outDir, "studyB", "series7"),
        stack({
            ctx: ctxB,
            seriesUID: fixedUID("30.7"),
            seriesNumber: 7,
            seriesDescription: "NO GEOMETRY",
            slices: 5,
            phases: 2,
            phaseTag: "none",
            includePosition: false,
            sliceMajor: false
        })
    );

    // (f) Plain single-phase anatomical stack, plus a non-DICOM decoy file.
    write(
        path.join(outDir, "studyB", "series1"),
        stack({
            ctx: ctxB,
            seriesUID: fixedUID("30.1"),
            seriesNumber: 1,
            seriesDescription: "T2 AX",
            slices: 10,
            phases: 1
        })
    );
    fs.writeFileSync(path.join(outDir, "studyB", "notes.txt"), "not a dicom\n");

    return outDir;
}

if (require.main === module) {
    const out = process.argv[2] || path.join(__dirname, "data");
    generate(out);
    const count = require("child_process").execSync(`find ${JSON.stringify(out)} -type f | wc -l`).toString().trim();
    console.log(`wrote ${count} files to ${out}`);
}

module.exports = { generate };
