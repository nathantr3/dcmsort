"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const dcmjs = require("dcmjs");
const { T, WRITE_VR, SCAN_UNTIL_TAG } = require("./tags");

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

// dcmjs logs a warning per element for things we expect and handle (implicit
// "ox" VRs, over-long CS values in vendor data). At scan scale that is tens of
// thousands of lines of noise, so keep it to genuine errors.
dcmjs.log.setLevel(dcmjs.log.levels.ERROR);

const PREAMBLE_LEN = 128;
const MAGIC = "DICM";

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Cheap pre-filter: confirm the DICM magic at offset 128 without parsing.
 * Avoids handing megabytes of JPEG/NIfTI/whatever to the parser.
 */
async function hasDicomMagic(filePath) {
    let handle;
    try {
        handle = await fsp.open(filePath, "r");
        const buf = Buffer.alloc(4);
        const { bytesRead } = await handle.read(buf, 0, 4, PREAMBLE_LEN);
        return bytesRead === 4 && buf.toString("latin1") === MAGIC;
    } catch {
        return false;
    } finally {
        if (handle) await handle.close();
    }
}

function toArrayBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Parse only up to SCAN_UNTIL_TAG. Returns a dcmjs DicomDict. */
function parseHeaderBuffer(buf) {
    return DicomMessage.readFile(toArrayBuffer(buf), {
        ignoreErrors: true,
        untilTag: SCAN_UNTIL_TAG,
        stopOnGreaterTag: true
    });
}

/** Parse the whole file, pixel data included. Returns a dcmjs DicomDict. */
function parseFullBuffer(buf) {
    return DicomMessage.readFile(toArrayBuffer(buf), { ignoreErrors: true });
}

async function readFull(filePath) {
    return parseFullBuffer(await fsp.readFile(filePath));
}

/* ------------------------------------------------------------------ */
/* Raw dict accessors                                                  */
/* ------------------------------------------------------------------ */

function rawValues(dict, tag) {
    const el = dict && dict[tag];
    if (!el || el.Value === undefined || el.Value === null) return null;
    const v = Array.isArray(el.Value) ? el.Value : [el.Value];
    return v.length ? v : null;
}

function getStr(dict, tag) {
    const v = rawValues(dict, tag);
    if (!v) return null;
    const first = v[0];
    if (first === null || first === undefined) return null;
    // PN values naturalize to { Alphabetic: "..." }
    if (typeof first === "object") return first.Alphabetic ?? String(first);
    return String(first).trim();
}

/** Multi-valued string, joined with backslash as DICOM would present it. */
function getStrAll(dict, tag) {
    const v = rawValues(dict, tag);
    if (!v) return null;
    return v.map((x) => (x === null || x === undefined ? "" : String(x).trim())).join("\\");
}

function getNum(dict, tag) {
    const v = rawValues(dict, tag);
    if (!v) return null;
    const n = Number(v[0]);
    return Number.isFinite(n) ? n : null;
}

function getNumArray(dict, tag) {
    const v = rawValues(dict, tag);
    if (!v) return null;
    const out = v.map(Number);
    return out.every(Number.isFinite) ? out : null;
}

/* ------------------------------------------------------------------ */
/* Metadata record                                                     */
/* ------------------------------------------------------------------ */

/**
 * Flatten a parsed DicomDict into the plain, structured-clone-safe record the
 * rest of the app works with. One record per file.
 */
function toRecord(dicomDict, filePath, fileSize) {
    const d = dicomDict.dict;
    const m = dicomDict.meta || {};

    return {
        filePath,
        fileSize: fileSize ?? null,
        transferSyntaxUID: getStr(m, T.TransferSyntaxUID),

        patientName: getStr(d, T.PatientName),
        patientID: getStr(d, T.PatientID),
        studyInstanceUID: getStr(d, T.StudyInstanceUID),
        studyDescription: getStr(d, T.StudyDescription),
        studyDate: getStr(d, T.StudyDate),
        studyTime: getStr(d, T.StudyTime),
        accessionNumber: getStr(d, T.AccessionNumber),

        seriesInstanceUID: getStr(d, T.SeriesInstanceUID),
        seriesNumber: getNum(d, T.SeriesNumber),
        seriesDescription: getStr(d, T.SeriesDescription),
        modality: getStr(d, T.Modality),

        sopInstanceUID: getStr(d, T.SOPInstanceUID),
        sopClassUID: getStr(d, T.SOPClassUID),
        instanceNumber: getNum(d, T.InstanceNumber),
        contentTime: getStr(d, T.ContentTime),
        acquisitionTime: getStr(d, T.AcquisitionTime),
        acquisitionNumber: getNum(d, T.AcquisitionNumber),

        imagePositionPatient: getNumArray(d, T.ImagePositionPatient),
        imageOrientationPatient: getNumArray(d, T.ImageOrientationPatient),
        sliceLocation: getNum(d, T.SliceLocation),
        frameOfReferenceUID: getStr(d, T.FrameOfReferenceUID),

        rows: getNum(d, T.Rows),
        columns: getNum(d, T.Columns),
        pixelSpacing: getNumArray(d, T.PixelSpacing),
        numberOfFrames: getNum(d, T.NumberOfFrames),

        imageType: getStrAll(d, T.ImageType),
        scanningSequence: getStrAll(d, T.ScanningSequence),
        sequenceVariant: getStrAll(d, T.SequenceVariant),
        sequenceName: getStr(d, T.SequenceName),
        protocolName: getStr(d, T.ProtocolName),
        echoNumbers: getNum(d, T.EchoNumbers),
        echoTime: getNum(d, T.EchoTime),
        repetitionTime: getNum(d, T.RepetitionTime),
        inversionTime: getNum(d, T.InversionTime),
        flipAngle: getNum(d, T.FlipAngle),
        contrastBolusAgent: getStr(d, T.ContrastBolusAgent),

        temporalPositionIdentifier: getNum(d, T.TemporalPositionIdentifier),
        numberOfTemporalPositions: getNum(d, T.NumberOfTemporalPositions),
        triggerTime: getNum(d, T.TriggerTime),
        cardiacNumberOfImages: getNum(d, T.CardiacNumberOfImages)
    };
}

/** Read one file's header and return its record, or null if it isn't DICOM. */
async function readRecord(filePath) {
    if (!(await hasDicomMagic(filePath))) return null;
    const buf = await fsp.readFile(filePath);
    const dict = parseHeaderBuffer(buf);
    const stat = await fsp.stat(filePath).catch(() => null);
    return toRecord(dict, filePath, stat ? stat.size : buf.length);
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Set a top-level tag on a parsed DicomDict, creating the element if absent.
 *
 * A parsed element carries both `Value` and `_rawValue`, and dcmjs's writer
 * prefers `_rawValue` when present, re-applying VR formatting to it. That
 * formatting assumes the raw form the parser produced (a string, for IS/DS),
 * so writing a fresh value into `_rawValue` blows up. Dropping `_rawValue`
 * instead makes the writer fall back to `Value`, which it encodes properly.
 */
function setTag(dicomDict, tag, value, container = "dict") {
    const target = container === "meta" ? dicomDict.meta : dicomDict.dict;
    const values = Array.isArray(value) ? value : [value];
    const existing = target[tag];
    if (existing) {
        existing.Value = values;
        delete existing._rawValue;
    } else {
        const vr = WRITE_VR[tag];
        if (!vr) throw new Error(`No VR known for tag ${tag}; add it to WRITE_VR`);
        target[tag] = { vr, Value: values };
    }
}

/** Fresh DICOM UID under the 2.25 (UUID-derived) root. */
function newUID() {
    return DicomMetaDictionary.uid();
}

async function writeDict(dicomDict, outPath) {
    const buf = Buffer.from(dicomDict.write({ allowInvalidVRLength: true }));
    await fsp.writeFile(outPath, buf);
    return buf.length;
}

module.exports = {
    // read
    hasDicomMagic,
    parseHeaderBuffer,
    parseFullBuffer,
    readFull,
    readRecord,
    toRecord,
    // accessors
    getStr,
    getStrAll,
    getNum,
    getNumArray,
    // write
    setTag,
    newUID,
    writeDict
};
