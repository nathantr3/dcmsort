import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import io from "../src/main/dicom-io.js";
import tags from "../src/main/tags.js";

const { T } = tags;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES = path.join(__dirname, "fixtures", "data");
let tmpDir;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmsort-io-"));
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const SAMPLE = path.join(FIXTURES, "studyA", "series4", "IM-00105.dcm");

/** Compare two raw dicts tag-by-tag, normalizing binary buffers to hex. */
function normalize(dict) {
    const out = {};
    for (const [tag, el] of Object.entries(dict)) {
        const v = el.Value;
        out[tag] = {
            vr: el.vr,
            value: (Array.isArray(v) ? v : [v]).map((x) => {
                if (x instanceof ArrayBuffer) return Buffer.from(x).toString("hex");
                if (ArrayBuffer.isView(x)) return Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString("hex");
                if (x && typeof x === "object") return JSON.stringify(x);
                return x;
            })
        };
    }
    return out;
}

describe("dicom-io", () => {
    it("detects DICM magic and rejects non-DICOM files", async () => {
        expect(await io.hasDicomMagic(SAMPLE)).toBe(true);
        expect(await io.hasDicomMagic(path.join(FIXTURES, "studyB", "notes.txt"))).toBe(false);
    });

    it("header-only parse stops before pixel data", async () => {
        const buf = fs.readFileSync(SAMPLE);
        const header = io.parseHeaderBuffer(buf);
        expect(header.dict["7FE00010"]).toBeUndefined();
        expect(io.getStr(header.dict, T.SeriesDescription)).toBe("MULTI RECON");
    });

    // The gate: dcmjs re-encodes the entire dataset on write, so an unmodified
    // round trip must reproduce every tag or the whole write strategy is unsafe.
    it("round-trips an unmodified file with every tag intact", async () => {
        const before = await io.readFull(SAMPLE);
        const out = path.join(tmpDir, "roundtrip.dcm");
        await io.writeDict(before, out);
        const after = await io.readFull(out);

        expect(normalize(after.dict)).toEqual(normalize(before.dict));
        expect(normalize(after.meta)).toEqual(normalize(before.meta));
    });

    it("preserves pixel data bytes across a round trip", async () => {
        const before = await io.readFull(SAMPLE);
        const out = path.join(tmpDir, "pixels.dcm");
        await io.writeDict(before, out);
        const after = await io.readFull(out);

        const pxBefore = Buffer.from(before.dict["7FE00010"].Value[0]);
        const pxAfter = Buffer.from(after.dict["7FE00010"].Value[0]);
        expect(pxAfter.equals(pxBefore)).toBe(true);
    });

    it("setTag updates existing elements and creates missing ones", async () => {
        const dict = await io.readFull(SAMPLE);
        const newUID = io.newUID();

        io.setTag(dict, T.SeriesInstanceUID, newUID);
        io.setTag(dict, T.SeriesNumber, 401);
        io.setTag(dict, T.SeriesDescription, "REWRITTEN");
        io.setTag(dict, T.MediaStorageSOPInstanceUID, "1.2.3.4.5", "meta");

        const out = path.join(tmpDir, "modified.dcm");
        await io.writeDict(dict, out);
        const after = await io.readFull(out);

        expect(io.getStr(after.dict, T.SeriesInstanceUID)).toBe(newUID);
        expect(io.getNum(after.dict, T.SeriesNumber)).toBe(401);
        expect(io.getStr(after.dict, T.SeriesDescription)).toBe("REWRITTEN");
        expect(io.getStr(after.meta, T.MediaStorageSOPInstanceUID)).toBe("1.2.3.4.5");
        // Untouched tags survive the edit.
        expect(io.getStr(after.dict, T.SOPInstanceUID)).toBe(io.getStr(dict.dict, T.SOPInstanceUID));
    });

    it("newUID produces distinct, well-formed UIDs", () => {
        const a = io.newUID();
        const b = io.newUID();
        expect(a).not.toBe(b);
        for (const uid of [a, b]) {
            expect(uid.length).toBeLessThanOrEqual(64);
            expect(uid).toMatch(/^2\.25\.\d+$/);
        }
    });
});
