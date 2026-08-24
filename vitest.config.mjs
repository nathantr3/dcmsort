import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.mjs"],
        // Fixtures are generated, not committed. Test files run in parallel
        // workers, so generation has to happen once, here, before any of them
        // start - otherwise they race and clobber each other's data.
        globalSetup: ["test/global-setup.mjs"]
    }
});
