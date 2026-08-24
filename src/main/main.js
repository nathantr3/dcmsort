"use strict";

const path = require("path");
const { app, BrowserWindow, Menu, shell } = require("electron");

const ipc = require("./ipc");

let mainWindow = null;

/** Folder to open on launch, from --open <dir> or DCMSORT_OPEN_DIR. */
function resolveStartupDir() {
    const flagIndex = process.argv.indexOf("--open");
    const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : null;
    const dir = fromFlag || process.env.DCMSORT_OPEN_DIR;
    return dir ? path.resolve(dir) : null;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1500,
        height: 950,
        minWidth: 1100,
        minHeight: 700,
        backgroundColor: "#1e1e1e",
        title: "dcmsort",
        titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

    // A folder can be named up front, which saves reaching for the picker and
    // makes the app scriptable: `npm start -- --open <dir>` or DCMSORT_OPEN_DIR.
    const startupDir = resolveStartupDir();
    if (startupDir) {
        mainWindow.webContents.once("did-finish-load", () => {
            mainWindow.webContents.send("app:open-path", startupDir);
        });
    }

    // Anything that is not the app itself opens in the real browser.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

/** Menu commands are forwarded to the renderer, which owns the UI state. */
function emit(command) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("menu:command", command);
}

function buildMenu() {
    const isMac = process.platform === "darwin";

    const template = [
        ...(isMac ? [{ role: "appMenu" }] : []),
        {
            label: "File",
            submenu: [
                { label: "Open Folder...", accelerator: "CmdOrCtrl+O", click: () => emit("open-folder") },
                { type: "separator" },
                { label: "Load Rule Set...", accelerator: "CmdOrCtrl+L", click: () => emit("load-rules") },
                { label: "Save Rule Set...", accelerator: "CmdOrCtrl+S", click: () => emit("save-rules") },
                { type: "separator" },
                { label: "Export...", accelerator: "CmdOrCtrl+E", click: () => emit("export") },
                { type: "separator" },
                isMac ? { role: "close" } : { role: "quit" }
            ]
        },
        { role: "editMenu" },
        {
            label: "View",
            submenu: [
                { label: "Back to Library", accelerator: "CmdOrCtrl+B", click: () => emit("back-to-library") },
                { type: "separator" },
                { role: "reload" },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" }
            ]
        },
        { role: "windowMenu" }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
    ipc.register();
    buildMenu();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
