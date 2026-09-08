# Integrating the Muse headband into CIQ

For the developer wiring Muse 2 / Muse S into the CIQ MVP. Everything here was
learned by running a real headband (`Muse-39E1`, firmware 1.0.27) against this
code; the measurements behind each claim are in
[`muse-2-findings.md`](./muse-2-findings.md).

> **Where this landed in this repo.** The code described in §2 is already
> applied on this branch:
> `app/frontend/src/muse/` (core, byte-identical to the source repo),
> `app/frontend/src/session/`, `app/frontend/src/ui/errors.ts`,
> `app/frontend/src/support.ts`.
> Paths deliberately mirror `muse-web-bridge` exactly, so no import was edited
> and a future re-sync is a plain copy. Run the tests with
> `cd app/frontend && npm test`.

Read section 1 before you write anything. It is short, and every item in it cost
real time to discover. The code is the cheap half of this handoff.

---

## 1. Five things that will cost you a day each

### Time packets by `seq`, never by `t_ms`

`t_ms` is stamped when the BLE notification *arrives*. Measured jitter is up to
**47 ms** against a 46.9 ms packet period — the arrival order is not even
reliably the sample order. Anything interval-based computed from `t_ms` is
wrong. Every packet carries a 16-bit `seq`, and it is exact:

```
EEG  t = (seq × 12 + k) / 256 s
PPG  t = (seq ×  6 + k) /  64 s
IMU  t = (seq ×  3 + k) /  52 s
```

`t_ms` is still recorded, because it is what the host saw. Use it for ordering
and for nothing else. LibMuse's own timestamps are *worse* (bursty, max gap
2289 ms) and it exposes no sequence number, so it is not a timing reference
either.

### The microvolt scale is not settled — record it, don't fix it

Against LibMuse this project's constant is **21.2% too large**, and that part is
confirmed: LibMuse's output falls on a uniform 0.4029304 µV grid, and
`0.4029304 × 4095 = 1650.00`, matching the `afe_gain: 2000` the headband itself
reports. So our `0.48828125` (inherited from muse-js) is not LibMuse's number.

But "correct" is a different question, and nothing available answers it. Three
constants are in active use, spanning ~35%:

| source | µV per LSB | implied full scale |
|---|---|---|
| muse-js lineage — what this code uses | 0.48828125 | 2000 µV |
| LibMuse 8.0.9, measured from its output | 0.4029304 | 1650 µV |
| Krigolson lab (published Muse research) | 0.662813 | 2714 µV |

No InterAxon document states the true value — not the SDK docs, not the headers,
not the MuseLab guide. So **every session file records `eeg.uv_per_lsb` and
`eeg.zero_code`**, and a consumer rescales with
`uv × (their_uv_per_lsb / uv_per_lsb)`. Do not silently swap the constant; you
would invalidate every recording made so far and still not be right.

Nothing *relative* is affected — peak frequencies, power ratios, spectral shape,
artifact multipliers all survive a linear rescale untouched. If CIQ scores
against a person's own baseline (and per the pitch deck it does), this
uncertainty largely cancels.

### The stability light is not a fit score

`stability.ts` reports `unstable` / `settling` / `stable` from the spread of the
last second of samples. It is **not** InterAxon's HSI horseshoe indicator, and
this is measured rather than asserted: calibrated against LibMuse's real HSI over
532 channel-seconds, standard deviation separates good contact from bad at only
**83.5% accuracy and lets 92% of bad seconds through**.

It tracks signal spread. HSI tracks electrode fit. Never label it "fit",
"contact", "signal quality" or anything a user would read as "your headband is
on correctly". Its thresholds are also derived from our µV scale, so they carry
the same 21.2% offset.

For a quality indicator that *does* track reality, use the PPG rejection ratio —
`rejected / (rejected + ibiMs.length)` from `pulseMetrics()`. Measured 3% sitting
still with good contact, 19% with poor contact.

### PPG: use the infrared channel, and call it PRV

`ambient` is a light reference, not a pulse signal. On real data it rejects 36 of
82 intervals against infrared's 4. Use `infrared`.

Report the result as **PRV** (pulse rate variability), never HRV. Pulse transit
time from heart to forehead varies, so these numbers carry non-cardiac variation
that ECG-derived HRV does not. The distinction matters if any of it reaches a
clinical-sounding claim.

And **heart rate comes from accepted intervals, never from beat count**. On poor
contact the detector under-counts beats by ~24% and the two methods disagree by
18 bpm. `pulseMetrics().bpm` is the interval-based one, and there is a test
pinning it.

### One host at a time

The headband accepts a single connection. The web bridge and any LibMuse-based
tool cannot run together — comparison runs are sequential recordings, so compare
distributions and event structure, never individual samples.

---

## 2. What to copy, and where it goes

### The core — `app/frontend/src/muse/`

Copy the folder as-is. It is **8 source files plus 6 test files, with zero
runtime dependencies** — plain TypeScript over `DataView`/`Uint8Array`.

| file | what it is |
|---|---|
| `index.ts` | the barrel; the only import path you need |
| `protocol.ts` | BLE UUIDs, presets, rates, control-command framing |
| `types.ts` | `MuseSource`, the reading types, narrow Web Bluetooth interfaces |
| `decode.ts` | pure packet decoders → physical units |
| `pack.ts` | builds the same bytes the device sends (for your own fakes) |
| `emitter.ts` | small typed event emitter |
| `client.ts` | `WebBluetoothMuse` — the real headband |
| `simulated.ts` | `SimulatedMuse` — a headband that needs no hardware |

The folder touches no DOM global and imports nothing outside itself.
`navigator.bluetooth` is **passed in**, not referenced — which is what makes it
portable and what makes it testable.

### The five files that must travel with it

These are pure and dependency-free but live outside `src/muse/` today. Take them
or you will rewrite them:

| file | why you want it |
|---|---|
| `session/pulse.ts` | `detectBeats()` + `pulseMetrics()` — PRV. Carries the local-threshold design that took two attempts to get right |
| `session/stability.ts` | `stabilityOf()` + `RollingWindow`, with calibrated thresholds |
| `session/drops.ts` | `DropCounter` — packet loss from `seq` gaps, handling 16-bit wrap |
| `ui/errors.ts` | maps raw Web Bluetooth exceptions to copy a user can act on |
| `support.ts` | `isWebBluetoothAvailable(nav)` — three lines, but it is the check that decides whether you offer the real headband at all |

### Optional, if you want to record sessions

`session/recorder.ts` (the `muse-web-bridge/3` file format), `session/example.ts`
plus `scripts/make-example-session.mjs` (generates fixtures with no hardware),
and `session/protocol.ts` (the guided bench protocol).

### Leave behind

`main.ts`, `ui/traces.ts`, `ui/status.ts`, `index.html`, `style.css` — prototype
page wiring. `main.ts` is still worth *reading* once as a worked example of how
the pieces connect; it is just not code to take.

---

## 3. It already fits the CIQ frontend

Checked against `origin/release/ciq-alpha-v2` (not `main`, which per that repo's
own `CLAUDE.md` is not the product):

| | this project | CIQ frontend |
|---|---|---|
| vitest | `^4.1.9` | `^4.1.9` |
| test environment | `node`, `globals: true` | `node`, `globals: true` |
| test discovery | co-located `*.test.ts` | `src/**/*.test.ts` |
| runtime deps needed | none | — |

So the tests drop in and run — no config change. Both codebases import
`{ describe, it, expect }` from `"vitest"` explicitly, so the `types:
["vitest/globals"]` difference between the tsconfigs is harmless.

**Two toolchain snags, both already fixed at source.** Recorded so they do not
come back:

- **`ES2020` target.** `client.test.ts` used `Array.prototype.at()`, which is
  ES2022. It is an index now, and the whole portable set compiles at ES2020.
- **TypeScript 5.6.2.** Your lockfile pins 5.6.2, and `protocol.ts` annotated a
  return as `Uint8Array<ArrayBuffer>`. Typed arrays only became generic in
  TS 5.7, so 5.6 fails with *"Type 'Uint8Array' is not generic"*. That return
  type is inferred now, which gives each TypeScript version the type its own lib
  defines. Do not re-add the annotation unless both repos are past 5.7.

Verified on this branch against your pinned toolchain: `npm test` → **142 tests
passing across 16 files**, `npm run build` → clean, and `npm run
example:session` reproduces the committed fixture byte for byte.

You also already have `hooks/useBiometrics.ts` for mediapipe face/gaze. A
`useMuse` sibling hook is the obvious shape, but that is your architectural call
— this doc describes the contract, not where you mount it.

---

## 4. The API

Both sources implement the same interface, so the simulated headband substitutes
for the real one with no other change:

```ts
interface MuseSource {
    readonly kind: "bluetooth" | "simulated";
    connect(opts: { preset: Preset }): Promise<DeviceInfo>;
    start(): Promise<StartInstant>;
    stop(): Promise<void>;
    on<K extends keyof MuseEvents>(event: K, fn: (payload: MuseEvents[K]) => void): () => void;
}
```

`on()` returns its own unsubscribe function. Events are `eeg`, `imu`, `ppg`,
`telemetry`, `disconnected`.

```ts
import { WebBluetoothMuse, SimulatedMuse, type MuseSource } from "@/muse";

// `navigator.bluetooth` is injected — the folder never reaches for it.
const nav = navigator as unknown as { bluetooth?: BluetoothLike };
const source: MuseSource = nav.bluetooth
    ? new WebBluetoothMuse(nav.bluetooth)
    : new SimulatedMuse();

const device = await source.connect({ preset: "p50" });
const off = source.on("eeg", r => {
    // r.ch is TP9 | AF7 | AF8 | TP10 (| AUX under p20)
    // r.uV holds 12 samples; time them from r.seq, not r.tMs
});
const t0 = await source.start();   // { monoMs, epochMs }
// ...
off();
await source.stop();
```

Two notes on the calls:

- **`connect()` must be triggered by a user gesture.** Web Bluetooth requires it,
  and it is Chromium-only (Chrome, Edge, Opera) — no Safari, no Firefox.
  `support.ts` has the capability check. `localhost` counts as a secure context,
  so no HTTPS is needed in development.
- **`start()` returns `StartInstant`, and both fields come from one read.**
  `monoMs` is the origin every `tMs` counts from; `epochMs` says what wall-clock
  instant that origin was. They must come from a single read or the anchor names
  an instant the packets are not counted from. Keep it if you ever need to line a
  recording up against another device's clock.

### Presets

| preset | streams |
|---|---|
| `p21` | 4 EEG channels + IMU |
| `p20` | 4 EEG + AUX electrode + IMU |
| `p50` | 4 EEG + IMU + **PPG** |

Use `p50`. It held **0 dropped packets over 113 s** with EEG + IMU + PPG all
running, so there is no bandwidth argument for the cheaper presets.

---

## 5. Building without a headband

`SimulatedMuse` produces the *same bytes* a real device sends and pushes them
through the same decoders, so the whole path is exercised end to end:

```ts
const sim = new SimulatedMuse({ seed: 1 });
sim.eyesClosed = true;   // adds a 10 Hz alpha rhythm on TP9/TP10
```

It gives you a 10 Hz alpha on the temporal channels when `eyesClosed`, blink
artifacts on AF7/AF8 every 4 s, dropped packets every 97th on AF7, and a battery
that ticks down from 87%.

`app/frontend/docs/example-session.json` is a committed 20-second `p50` recording produced
this way — read it to understand the file format without owning a headband.
Regenerate with `cd app/frontend && npm run example:session`.

> **The simulator is for plumbing, not for signal processing.** Its PPG is a
> constant-amplitude 1.1 Hz sine, identical on all three optical channels. Real
> PPG is neither, and `ambient` carries no pulse at all. The first beat detector
> passed every synthetic test and then found 19 beats in 113 s of real data. If
> you touch the signal-processing code, test it with varying amplitude and
> injected artefacts, or it will pass and be broken.

---

## 6. The session file (`muse-web-bridge/3`)

Self-describing by design — a consumer can rescale or re-time without knowing
which version of this code wrote it.

```jsonc
{
  "schema": "muse-web-bridge/3",
  "recorded_at": "2026-09-04T09:14:52.000Z",  // page set up
  "t0_epoch_ms": 1788513300000,               // wall clock at seq = 0
  "device": { "name": "...", "firmware": "...", "raw": { } },
  "preset": "p50",
  "consent": { "accepted_at": "..." },
  "eeg": {
    "rate_hz": 256, "units": "uV",
    "uv_per_lsb": 0.48828125, "zero_code": 2048,   // rescale from these
    "channels": ["TP9", "AF7", "AF8", "TP10"],
    "packets": [ { "ch": "TP9", "seq": 0, "t_ms": 0, "v": [ ] } ],
    "dropped_packets": { "TP9": 0, "AF7": 4 }
  },
  "accelerometer": { "rate_hz": 52, "units": "g",     "packets": [ ] },
  "gyroscope":     { "rate_hz": 52, "units": "deg/s", "packets": [ ] },
  "ppg": { "rate_hz": 64, "units": "counts", "channels": ["ambient","infrared","red"], "packets": [ ] },
  "telemetry": [ { "t_ms": 0, "battery_percent": 87, "fuel_gauge_mv": 3700, "temperature": 30 } ],
  "markers": [ ]
}
```

- `t0_epoch_ms` is **absent**, never `0`, when streaming never started.
- It is an offset to refine, not a reference: it is host-stamped, so it carries
  the same arrival jitter. It does not change how packets are timed — `seq`
  still does that.
- `temperature` is the raw 16-bit telemetry field. The headband sends it; its
  units are unverified against any InterAxon documentation.
- `markers` appears only when a guided protocol was run.

---

## 7. What must never reach a user

- **The stability light as a fit or contact score.** See §1. It is a spread
  measure with 83.5% accuracy against real HSI.
- **Absolute microvolts presented as calibrated.** They are uncertain by ~35%.
- **"HRV".** It is PRV.
- **Heart rate derived from beat count.** Use `pulseMetrics().bpm`.
- Anything framed as a clinical or diagnostic reading. Consistent with CIQ's
  existing product line — *"the participant sees a result, not a readout"*, and
  *"direction of travel, not a verdict"*.

## 8. Not available over Bluetooth

Calm/focus scores, InterAxon's HSI fit indicator, and hardware timestamps are
computed **inside LibMuse and never transmitted**. They are not missing from
this code; they are absent from the raw BLE stream it reads.

They *are* obtainable through LibMuse itself — the RDK's macOS framework exposes
`Hsi`, `Artifacts` (blink / jawClench / headbandOn), `IsGood` / `IsPpgGood` /
`IsHeartGood`, `DroppedEeg`, `NotchFilteredEeg` and band powers in Absolute,
Relative and Score forms. A comparison harness lives at `../muse-libmuse-probe`.
If CIQ needs a real fit indicator, that is the route — not a better threshold on
standard deviation.

## 9. If you run a bench session

**The protocol order is load-bearing.** A jaw clench displaces electrodes by
hundreds of microvolts and they take tens of seconds to recover. The first bench
run lost its entire eyes-closed window that way. Everything that disturbs contact
runs *after* the measurement, and there is a test asserting the ordering — do not
reorder it. Also discard the first ~20 s of any eyes-closed block; the large
excursions in the first seconds are a settling transient.

## 10. The open question, if you ever reach InterAxon

Specific enough to be answerable:

> What is the ADC reference voltage and µV-per-LSB for Muse 2 EEG, and does
> `getEegChannelValue` return true microvolts or a gain-uncorrected value?

---

## Where the evidence lives

| | |
|---|---|
| [`muse-2-findings.md`](./muse-2-findings.md) | every measurement, three dated bench sessions, the LibMuse comparison, known gaps |
| `app/frontend/docs/example-session.json` | a real file in the current schema |
| the `muse-web-bridge` repo | the standalone prototype this came from: a runnable page, the bench harness, and its README's manual validation script |
| `muse-libmuse-probe` | macOS app on InterAxon's LibMuse, for comparison runs |
| the MUSE RDK | SDK, MuseLab, and libmuse for every platform |

The prototype repo is where this code is developed and where the hardware log is
kept. Changes to `src/muse/` are best made there and copied back, so the two
copies stay identical.
