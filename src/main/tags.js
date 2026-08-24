"use strict";

/**
 * Raw DICOM tag keys (dcmjs dict keys are 8-char uppercase hex, no delimiters).
 * We read from the raw dict rather than naturalizing: it is both faster and
 * unambiguous about which attribute we actually touched.
 */
const T = {
    // Patient / Study
    PatientName: "00100010",
    PatientID: "00100020",
    StudyInstanceUID: "0020000D",
    StudyDescription: "00081030",
    StudyDate: "00080020",
    StudyTime: "00080030",
    AccessionNumber: "00080050",

    // Series
    SeriesInstanceUID: "0020000E",
    SeriesNumber: "00200011",
    SeriesDescription: "0008103E",
    Modality: "00080060",
    SeriesTime: "00080031",

    // Instance
    SOPClassUID: "00080016",
    SOPInstanceUID: "00080018",
    InstanceNumber: "00200013",
    ContentTime: "00080033",
    AcquisitionTime: "00080032",
    AcquisitionNumber: "00200012",

    // Geometry
    ImagePositionPatient: "00200032",
    ImageOrientationPatient: "00200037",
    SliceLocation: "00201041",
    FrameOfReferenceUID: "00200052",

    // Image shape
    Rows: "00280010",
    Columns: "00280011",
    PixelSpacing: "00280030",
    NumberOfFrames: "00280008",

    // Acquisition character (cohort signature)
    ImageType: "00080008",
    ScanningSequence: "00180020",
    SequenceVariant: "00180021",
    SequenceName: "00180024",
    ProtocolName: "00181030",
    EchoNumbers: "00180086",
    EchoTime: "00180081",
    RepetitionTime: "00180080",
    InversionTime: "00180082",
    FlipAngle: "00181314",
    ContrastBolusAgent: "00180010",

    // Temporal
    TemporalPositionIdentifier: "00200100",
    NumberOfTemporalPositions: "00200105",
    TriggerTime: "00181060",
    CardiacNumberOfImages: "00181090",

    // File meta
    MediaStorageSOPClassUID: "00020002",
    MediaStorageSOPInstanceUID: "00020003",
    TransferSyntaxUID: "00020010"
};

/** VRs for the tags we ever write, so upsert can create a missing element. */
const WRITE_VR = {
    [T.SeriesInstanceUID]: "UI",
    [T.SeriesNumber]: "IS",
    [T.SeriesDescription]: "LO",
    [T.SOPInstanceUID]: "UI",
    [T.InstanceNumber]: "IS",
    [T.MediaStorageSOPInstanceUID]: "UI"
};

/**
 * Highest tag group the scanner needs. Reading stops here so pixel data and
 * trailing private blocks are never decoded during a scan.
 */
const SCAN_UNTIL_TAG = "00290000";

module.exports = { T, WRITE_VR, SCAN_UNTIL_TAG };
