"use strict";

/**
 * Groups flat scan records into the Exam > Series > File tree the library view
 * renders. Purely structural: no DICOM knowledge beyond the identifying UIDs.
 */

const path = require("path");

const UNKNOWN_STUDY = "(no StudyInstanceUID)";
const UNKNOWN_SERIES = "(no SeriesInstanceUID)";

function formatDate(dicomDate) {
    if (!dicomDate || dicomDate.length !== 8) return dicomDate || "";
    return `${dicomDate.slice(0, 4)}-${dicomDate.slice(4, 6)}-${dicomDate.slice(6, 8)}`;
}

/** Sort helper that puts numbered items in numeric order, unnumbered last. */
function bySeriesNumber(a, b) {
    const an = Number.isFinite(a.seriesNumber) ? a.seriesNumber : Infinity;
    const bn = Number.isFinite(b.seriesNumber) ? b.seriesNumber : Infinity;
    return an - bn || String(a.seriesDescription).localeCompare(String(b.seriesDescription));
}

/**
 * @param {object[]} records scan records
 * @returns {{studies: object[], totals: object}}
 */
function buildLibrary(records) {
    const studies = new Map();

    for (const r of records) {
        const studyKey = r.studyInstanceUID || UNKNOWN_STUDY;
        if (!studies.has(studyKey)) {
            studies.set(studyKey, {
                studyInstanceUID: studyKey,
                patientName: r.patientName || "(no name)",
                patientID: r.patientID || "",
                studyDescription: r.studyDescription || "(no description)",
                studyDate: formatDate(r.studyDate),
                accessionNumber: r.accessionNumber || "",
                series: new Map()
            });
        }
        const study = studies.get(studyKey);

        const seriesKey = r.seriesInstanceUID || UNKNOWN_SERIES;
        if (!study.series.has(seriesKey)) {
            study.series.set(seriesKey, {
                seriesInstanceUID: seriesKey,
                studyInstanceUID: studyKey,
                seriesNumber: Number.isFinite(r.seriesNumber) ? r.seriesNumber : null,
                seriesDescription: r.seriesDescription || "(no description)",
                modality: r.modality || "",
                fileCount: 0,
                directories: new Set()
            });
        }
        const series = study.series.get(seriesKey);
        series.fileCount++;
        series.directories.add(path.dirname(r.filePath));
    }

    const out = [...studies.values()]
        .map((s) => ({
            ...s,
            series: [...s.series.values()]
                .map((se) => ({ ...se, directories: [...se.directories] }))
                .sort(bySeriesNumber)
        }))
        .sort(
            (a, b) =>
                String(a.patientName).localeCompare(String(b.patientName)) ||
                String(a.studyDate).localeCompare(String(b.studyDate))
        );

    return {
        studies: out,
        totals: {
            studies: out.length,
            series: out.reduce((n, s) => n + s.series.length, 0),
            files: records.length
        }
    };
}

/**
 * Split flat scan records into one group per series, ordered the way
 * buildLibrary orders them so every view agrees.
 *
 * Analysing a series on its own is the unit of work for applying a rule set,
 * in the CLI and when working out which series a rule file fits, so the
 * grouping lives here rather than in either caller.
 *
 * @param {object[]} records scan records
 * @returns {{seriesInstanceUID: string, records: object[]}[]}
 */
function groupBySeries(records) {
    const groups = new Map();

    for (const record of records) {
        const uid = record.seriesInstanceUID;
        if (!groups.has(uid)) groups.set(uid, { seriesInstanceUID: uid, records: [] });
        groups.get(uid).records.push(record);
    }

    return [...groups.values()].sort((a, b) => bySeriesNumber(a.records[0], b.records[0]));
}

module.exports = { buildLibrary, groupBySeries, formatDate };
