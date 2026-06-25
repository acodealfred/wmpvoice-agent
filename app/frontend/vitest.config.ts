import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
    test: {
        environment: "node",          // band helpers are pure — no DOM needed
        globals: true,
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
});
