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

/**
 * A total order over series, so volume ids mean the same thing on every run.
 *
 * Rules bind to volumes positionally, and volumes are numbered by walking the
 * selected series in order - so any two series that could tie here would make
 * a saved rule set select different images from one run to the next. The last
 * rung settles it outright: the first file path is unique to a series even
 * when its number, exam and timestamps are identical to another's.
 */
function seriesSortKey(sample, firstFilePath) {
    return {
        seriesNumber: Number.isFinite(sample.seriesNumber) ? sample.seriesNumber : Infinity,
        accessionNumber: sample.accessionNumber || "",
        studyInstanceUID: sample.studyInstanceUID || "",
        when: `${sample.studyDate || ""}${sample.studyTime || ""}`,
        firstFilePath: firstFilePath || ""
    };
}

function compareSeries(a, b) {
    // Subtracting would give NaN for two unnumbered series, which sorts as 0
    // only by accident; be explicit.
    const byNumber = a.seriesNumber === b.seriesNumber ? 0 : a.seriesNumber - b.seriesNumber;

    return (
        byNumber ||
        a.accessionNumber.localeCompare(b.accessionNumber) ||
        a.studyInstanceUID.localeCompare(b.studyInstanceUID) ||
        a.when.localeCompare(b.when) ||
        a.firstFilePath.localeCompare(b.firstFilePath)
    );
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
                directories: new Set(),
                sortKey: seriesSortKey(r, r.filePath)
            });
        }
        const series = study.series.get(seriesKey);
        series.fileCount++;
        series.directories.add(path.dirname(r.filePath));
        // Records usually arrive path-sorted, but do not depend on it.
        if (r.filePath < series.sortKey.firstFilePath) series.sortKey.firstFilePath = r.filePath;
    }

    const out = [...studies.values()]
        .map((s) => ({
            ...s,
            series: [...s.series.values()]
                .sort((a, b) => compareSeries(a.sortKey, b.sortKey))
                // The sort key is internal; the renderer never sees it.
                .map(({ sortKey, ...se }) => ({ ...se, directories: [...se.directories] }))
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
        if (!groups.has(uid)) {
            groups.set(uid, { seriesInstanceUID: uid, records: [], sortKey: seriesSortKey(record, record.filePath) });
        }
        const group = groups.get(uid);
        group.records.push(record);
        if (record.filePath < group.sortKey.firstFilePath) group.sortKey.firstFilePath = record.filePath;
    }

    return [...groups.values()]
        .sort((a, b) => compareSeries(a.sortKey, b.sortKey))
        .map(({ sortKey, ...group }) => group);
}

module.exports = { buildLibrary, groupBySeries, seriesSortKey, compareSeries, formatDate };
