"use strict";

/**
 * Minimal Electron entry point used only by scripts/make-icon.mjs: an
 * offscreen, transparent window that acts as an SVG rasterizer. Not part of
 * the dcmsort application itself.
 */

const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 1024,
        height: 1024,
        show: false,
        transparent: true,
        frame: false
    });
    // Playwright only reports a window once its webContents has navigated, so
    // load something before it starts waiting.
    win.loadURL("data:text/html,<html></html>");
});

app.on("window-all-closed", () => app.quit());
