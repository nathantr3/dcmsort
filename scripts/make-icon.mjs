/**
 * Renders build/icon.svg into the platform icon files electron-builder wants.
 *
 * There is no rasterizer in the dependency tree, but there is a whole Chromium
 * in node_modules/electron - so the SVG is rendered by loading it in an
 * offscreen Electron window and screenshotting it. That keeps the icon
 * reproducible from source with no extra toolchain.
 *
 *   node scripts/make-icon.mjs
 *
 * Produces build/icon.png (1024px, for Linux and as electron-builder's
 * fallback) and, on macOS, build/icon.icns via the system iconutil.
 */

import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "build");
const SVG = path.join(BUILD, "icon.svg");
const PNG = path.join(BUILD, "icon.png");
const ICNS = path.join(BUILD, "icon.icns");

/** The sizes an .iconset needs, as (filename, pixel size) pairs. */
const ICONSET = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024]
];

const electronBin =
    process.platform === "darwin"
        ? path.join(ROOT, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
        : path.join(ROOT, "node_modules/electron/dist/electron");

/** Render the SVG at `size` px square, on a transparent background. */
async function renderPng(page, size, outPath) {
    const svg = fs.readFileSync(SVG, "utf8");
    const html = `<!doctype html><meta charset="utf-8">
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          svg { display: block; width: ${size}px; height: ${size}px; }
        </style>
        ${svg}`;

    await page.setViewportSize({ width: size, height: size });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: outPath, omitBackground: true });
}

async function main() {
    if (!fs.existsSync(SVG)) throw new Error(`missing ${SVG}`);
    fs.mkdirSync(BUILD, { recursive: true });

    // A bare Electron with no app directory: we only want its renderer.
    const app = await electron.launch({
        executablePath: electronBin,
        args: [path.join(ROOT, "scripts", "icon-host.js")],
        timeout: 30_000
    });
    const page = await app.firstWindow();

    try {
        await renderPng(page, 1024, PNG);
        console.log("wrote", path.relative(ROOT, PNG));

        if (process.platform !== "darwin") {
            console.log("not macOS - skipping .icns");
            return;
        }

        const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "dcmsort-icon-")) + ".iconset";
        fs.mkdirSync(iconset, { recursive: true });
        for (const [name, size] of ICONSET) {
            await renderPng(page, size, path.join(iconset, name));
        }

        execFileSync("iconutil", ["-c", "icns", iconset, "-o", ICNS]);
        fs.rmSync(iconset, { recursive: true, force: true });
        console.log("wrote", path.relative(ROOT, ICNS));
    } finally {
        await app.close().catch(() => {});
    }
}

await main();
