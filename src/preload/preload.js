"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * The renderer's entire view of the outside world. Each method is an explicit
 * channel; no ipcRenderer, no fs, and no node globals leak into page scripts.
 */
const api = {
    chooseDirectory: (title) => ipcRenderer.invoke("dialog:chooseDirectory", { title }),

    scanDirectory: (root) => ipcRenderer.invoke("scan:start", { root }),
    cancelScan: () => ipcRenderer.invoke("scan:cancel"),

    analyzeSelection: (seriesInstanceUIDs, phaseKeyOverrides) =>
        ipcRenderer.invoke("analyze:selection", { seriesInstanceUIDs, phaseKeyOverrides }),

    previewRules: (ruleSet) => ipcRenderer.invoke("rules:preview", { ruleSet }),
    checkRules: (ruleSet) => ipcRenderer.invoke("rules:check", { ruleSet }),
    saveRuleSet: (ruleSet) => ipcRenderer.invoke("rules:save", { ruleSet }),
    loadRuleSet: () => ipcRenderer.invoke("rules:load"),

    exportRules: (ruleSet, target) => ipcRenderer.invoke("export:run", { ruleSet, target }),
    cancelExport: () => ipcRenderer.invoke("export:cancel"),

    revealPath: (targetPath) => ipcRenderer.invoke("shell:revealPath", { targetPath }),

    // Subscriptions return an unsubscribe function so views can clean up.
    onScanProgress: (fn) => subscribe("scan:progress", fn),
    onExportProgress: (fn) => subscribe("export:progress", fn),
    onMenuCommand: (fn) => subscribe("menu:command", fn),
    onOpenPath: (fn) => subscribe("app:open-path", fn)
};

function subscribe(channel, fn) {
    const listener = (_event, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("dcmsort", api);
