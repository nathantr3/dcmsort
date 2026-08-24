import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fixtures from "./fixtures/generate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "data");

export default function setup() {
    if (!fs.existsSync(FIXTURES) || fs.readdirSync(FIXTURES).length === 0) {
        fixtures.generate(FIXTURES);
    }
}
