/**
 * REPL driver for the dcmsort window.
 *
 * The UI is a real Electron window, so it cannot be exercised by the unit
 * tests. This drives it programmatically instead: launch it, click things,
 * read text back, take screenshots.
 *
 *   node scripts/drive.mjs
 *   node scripts/drive.mjs --script scripts/smoke.txt
 *
 * Type `help` for the command list. Screenshots land in $SCREENSHOT_DIR
 * (default /tmp/dcmsort-shots).
 */

import { _electron as electron } from "playwright-core";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = process.env.SCREENSHOT_DIR || "/tmp/dcmsort-shots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

const electronBin =
    process.platform === "darwin"
        ? path.join(APP_DIR, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
        : path.join(APP_DIR, "node_modules/electron/dist/electron");

let app = null;
let page = null;
const logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMMANDS = {
    /** launch [folder] - start the app, optionally opening a folder immediately. */
    async launch(folder) {
        if (app) return console.log("already launched");
        const args = [APP_DIR];
        if (folder) args.push("--open", path.resolve(folder));

        app = await electron.launch({ executablePath: electronBin, args, timeout: 30_000 });
        page = await app.firstWindow();
        page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
        page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
        await page.waitForLoadState("domcontentloaded");
        await sleep(folder ? 3000 : 800);
        console.log("launched:", app.windows().map((w) => w.url()).join(", "));
    },

    /**
     * stub-dialogs <outDir> [rulesFile] - replace the native file dialogs in
     * the main process so export and save/load can run unattended.
     */
    async "stub-dialogs"(args) {
        const [outDir, rulesFile] = args.split(/\s+/);
        await app.evaluate(({ dialog }, { out, rules }) => {
            dialog.showOpenDialog = async (win, opts) => {
                if (opts.title === "Load rule set" && rules) return { canceled: false, filePaths: [rules] };
                if (opts.properties?.includes("openDirectory") && out) return { canceled: false, filePaths: [out] };
                return { canceled: true, filePaths: [] };
            };
            dialog.showSaveDialog = async () =>
                rules ? { canceled: false, filePath: rules } : { canceled: true };
        }, { out: outDir ? path.resolve(outDir) : null, rules: rulesFile ? path.resolve(rulesFile) : null });
        console.log("dialogs stubbed");
    },

    async ss(name) {
        const file = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`);
        await page.screenshot({ path: file });
        console.log("screenshot:", file);
    },

    /** DOM click, which avoids Playwright's coordinate maths entirely. */
    async click(selector) {
        const result = await page.evaluate((s) => {
            const node = document.querySelector(s);
            if (!node) return "NOT_FOUND";
            node.click();
            return "OK";
        }, selector);
        console.log("click", selector, "->", result);
    },

    /** click-text <text> - click the first element whose text contains <text>. */
    async "click-text"(text) {
        const result = await page.evaluate((t) => {
            const nodes = [...document.querySelectorAll("button, .series-row, .study-header, label")];
            const node = nodes.find((n) => n.textContent?.includes(t));
            if (!node) return "NOT_FOUND";
            node.click();
            return `OK: ${node.className || node.tagName}`;
        }, text);
        console.log("click-text", JSON.stringify(text), "->", result);
    },

    /**
     * set <selector> = <value> - set a field's value and fire its event.
     * The " = " delimiter is required because CSS selectors contain spaces.
     */
    async set(args) {
        const split = args.indexOf(" = ");
        if (split === -1) return console.log('ERROR: usage is `set <selector> = <value>`');
        const selector = args.slice(0, split).trim();
        const value = args.slice(split + 3);

        const result = await page.evaluate(
            ({ s, v }) => {
                const node = document.querySelector(s);
                if (!node) return "NOT_FOUND";
                if (!("value" in node)) return `NOT_A_FIELD: ${node.tagName}`;
                node.value = v;
                node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
                return "OK";
            },
            { s: selector, v: value }
        );
        console.log("set", selector, "=", JSON.stringify(value), "->", result);
    },

    async text(selector) {
        console.log(
            await page.evaluate(
                (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? "(null)",
                selector || null
            )
        );
    },

    async eval(expr) {
        try {
            console.log(JSON.stringify(await page.evaluate(expr)));
        } catch (err) {
            console.log("ERROR:", err.message);
        }
    },

    async sleep(ms) {
        await sleep(Number(ms) || 500);
    },

    logs() {
        console.log(logs.length ? logs.join("\n") : "(no console output)");
    },

    async quit() {
        if (app) await app.close().catch(() => {});
        app = null;
        page = null;
    },

    help() {
        console.log("commands:", Object.keys(COMMANDS).join(", "));
    }
};

async function runLine(line) {
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    const gap = text.indexOf(" ");
    const command = gap === -1 ? text : text.slice(0, gap);
    const arg = gap === -1 ? "" : text.slice(gap + 1);

    const fn = COMMANDS[command];
    if (!fn) return console.log("unknown:", command, "- try: help");
    try {
        await fn(arg);
    } catch (err) {
        console.log("ERROR:", err.message);
    }
}

const scriptIndex = process.argv.indexOf("--script");
if (scriptIndex !== -1) {
    const lines = fs.readFileSync(process.argv[scriptIndex + 1], "utf8").split("\n");
    for (const line of lines) await runLine(line);
    await COMMANDS.quit();
    process.exit(0);
}

// Electron grabs stdin, so read from the raw fd instead.
const stdin = fs.createReadStream(null, { fd: fs.openSync("/dev/stdin", "r") });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: "driver> " });

rl.on("line", async (line) => {
    await runLine(line);
    if (line.trim() === "quit") {
        rl.close();
        process.exit(0);
    }
    rl.prompt();
});
rl.on("close", async () => {
    await COMMANDS.quit();
    process.exit(0);
});

console.log('dcmsort driver - "help" for commands, "launch [folder]" to start');
rl.prompt();
