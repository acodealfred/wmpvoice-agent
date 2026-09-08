// Regenerates docs/example-session.json from the simulated headband.
//
//     npm run example:session
//
// Uses Vite's SSR loader rather than a TypeScript runner, so this needs no
// dependency the repo does not already have. The output is deterministic:
// fixed seed, fixed epoch, fixed virtual-clock step (see src/session/example.ts
// for why the step is part of the fixture's identity).
import { createServer } from "vite";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "example-session.json");

const server = await createServer({
    root,
    configFile: false,
    logLevel: "warn",
    server: { middlewareMode: true },
    appType: "custom",
    // Nothing here imports from node_modules, and in a host app with an
    // index.html Vite would otherwise start a dependency scan that outlives
    // server.close() and fails the script after it has already written the file.
    optimizeDeps: { noDiscovery: true, include: [] }
});

try {
    const { generateExampleSession } = await server.ssrLoadModule("/src/session/example.ts");
    const file = await generateExampleSession();
    // One packet per line: large enough to want compact, structured enough that
    // a diff stays readable and a reader can eyeball a single packet.
    const json = JSON.stringify(file, null, 1).replace(/\[\n\s+((?:-?[\d.]+,?\s*)+)\]/g, m => m.replace(/\s+/g, " "));
    writeFileSync(out, json + "\n");
    const counts = {
        eeg: file.eeg.packets.length,
        accel: file.accelerometer.packets.length,
        gyro: file.gyroscope.packets.length,
        ppg: file.ppg?.packets.length ?? 0,
        telemetry: file.telemetry.length,
        dropped: file.eeg.dropped_packets
    };
    console.log(`wrote ${out}`);
    console.log(JSON.stringify(counts));
} finally {
    await server.close();
}
