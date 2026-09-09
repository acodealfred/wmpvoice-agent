# Muse 2 — hardware findings

Living record of what the Muse 2 actually delivers over Web Bluetooth, measured
with `muse-web-bridge`. Add a dated section per bench session; correct earlier
claims in place and say so rather than deleting them.

**Headband under test:** `Muse-39E1`, fw `1.0.27`, hw `30.2`, `sp: Blackcomb_revB`,
`ap: headset`, `tp: consumer`, bootloader `1.1.0` — the full `v1` reply is kept
verbatim in every session file under `device.raw`.

**Host:** Chrome on macOS, page served from `http://127.0.0.1:5173` (localhost is a
secure context, so no HTTPS needed for bench work).

---

## Headline: it works

A browser page with no native software in the loop pulled a **real alpha rhythm at
9.50 Hz** off this headband on 2026-09-04. Decoding, sequencing, timing, telemetry
and PPG are all confirmed against real hardware.

---

## Confirmed on real hardware

| Fact | Measured |
|---|---|
| GATT service / control char | `0xFE8D` / `273e0001-…` — connects, accepts commands |
| `v1` handshake | Replies as JSON chunks; `fw`/`hw` parse correctly |
| Command order `h → v1 → p21|p50 → s → d` | Works; streaming starts reliably |
| EEG rate | 24,924 samples/channel over 97.4 s = **255.9 Hz** against nominal 256 |
| EEG sample spacing | median **3.9062 ms** = exactly 1/256 s |
| EEG scaling | `0.48828125 × (n − 2048)` µV — values land in physiological range |
| Packet loss, p21 | **0 dropped packets** over 97 s |
| Packet loss, p50 | **0 dropped EEG packets, 0 missing PPG packets** over 113 s |
| PPG | 3 channels × 64 Hz, 6 samples/packet, 24-bit — clean pulse |
| Telemetry | Battery decodes correctly (90%, later 80%) |

**p50 is free.** Adding PPG on top of EEG and motion cost nothing in packet loss.
There is no bandwidth reason to prefer p21.

---

## Timing: use `seq`, never `t_ms`

`t_ms` on every packet is stamped when the **BLE notification arrives**, not when
the sample was taken. Measured arrival jitter on the 2026-09-04 08:48 session was
**up to 47.03 ms** against a nominal 46.9 ms packet period. It averages out across
a session — 24,924 samples over 97.4 s is correct to 0.04% — but any single packet's
timestamp can be tens of milliseconds off.

**This is fatal for anything interval-based** (PRV/HRV especially), where the jitter
is the same order as the signal. Reconstruct the sample clock from the sequence
number instead, which is exact and jitter-free:

```
EEG    t = (seq × 12 + k) / 256   seconds
PPG    t = (seq × 6  + k) / 64    seconds
IMU    t = (seq × 3  + k) / 52    seconds
```

`seq` is present on every packet record in the session file. A dropped packet
leaves a hole but does **not** shift the timeline, because `seq` is absolute.

---

## Session 2026-09-04 08:48 — alpha NOT found, and why

Preset `p21`, protocol order `baseline → blinks → jaw clench → eyes closed (30 s) → eyes open`.

**No alpha peak.** Every channel decayed monotonically from 3 Hz. Peak power inside
a 6–14 Hz search landed at exactly 6.00 Hz — the band edge, meaning the true maximum
was below it. That is the 1/f slope, not a rhythm. The 8–12 Hz band did rise during
eyes-closed on TP10, but the gain was **broadband** (2.7× at 3 Hz, 4.9× at 10 Hz,
2.1× at 19 Hz) — spectrum-wide elevation, not alpha blocking.

**Root cause: step order.** The jaw clench immediately preceded the eyes-closed
block and displaced the electrodes. AF7's mean sat at **−404 µV** during the clench;
AF8 **railed at exactly 1000.0 µV** during eyes-closed. Splitting the eyes-closed
window into 5 s slices showed a clean settling curve — AF7 spread 306 → 258 → 259 →
113 → 71 → 31 µV, with large frontal excursions falling 13 → 12 → 11 → 7 → 2 → 1.
The 30 s block was spent recovering from the clench; by the time contact settled the
window was over.

The operator also reported sweating and opening their eyes to read the on-screen
timer. Both are consistent with the drift, but the settling curve — worst at the
start, decaying smoothly — shows recovery from the preceding step was the dominant
effect, not periodic peeking.

**Fixes applied:** artefact-generating steps moved *after* the measurement;
eyes-closed extended to 60 s; spoken audio cues added so the operator never needs
to look at the screen. Both verified on hardware in the 09:22 session — the
markers prove the new order ran, and the operator confirmed the spoken cues and
blips were audible in Chrome on macOS.

### What did work
Jaw clench raised 20–45 Hz EMG power **6.3× / 7.1× / 3.2× / 6.6×** (TP9/AF7/AF8/TP10)
against baseline. Unambiguous, correct band, correct direction — and only measurable
because the guided-protocol markers said where to look.

---

## Session 2026-09-04 09:22 — alpha CONFIRMED at 9.50 Hz

Preset `p50`, reordered protocol `baseline (20 s) → eyes closed (60 s) → eyes open
(10 s) → blinks (10 s) → jaw clench (5 s)`.

Method: fit the 1/f aperiodic slope over 3–30 Hz **excluding 7–13 Hz** so the fit is
not biased by the band under test, then measure the residual inside the band. Used
the **last 40 s** of the eyes-closed block, discarding the first 20 s of settling.

| channel | peak | above 1/f trend | best out-of-band residual | verdict |
|---|---|---|---|---|
| TP9 | **9.50 Hz** | **2.71×** | 1.78× | peak |
| TP10 | **9.50 Hz** | **4.07×** | 2.20× | peak |
| AF7 | 8.75 Hz | 1.78× | 2.17× | nothing above noise |
| AF8 | 10.50 Hz | 1.59× | 1.57× | nothing above noise |

Both temporal channels land on **exactly 9.50 Hz** and stand clear of their own
noise floors; both frontal channels show nothing. That posterior-strong,
frontal-weak gradient is the expected anatomy of alpha and nobody tuned for it.
Relative alpha (8–12 Hz over 2–45 Hz) rose from 5.4% → 12.5% on TP9 and
5.2% → 14.4% on TP10.

Contact settled *inside* the 60 s block: TP10 spread fell 86 → 23 µV across it.
The protocol was started 3.1 s into the session rather than after the recommended
45–60 s settle, and the longer block absorbed that.

Jaw clench again clear: 20–45 Hz up **4.5× / 3.8× / 1.9× / 5.0×**.

**Analysis note:** discard the first ~20 s of any eyes-closed block. Better still,
start the guided protocol only after the traces have visibly settled.

---

## PPG and PRV

**Pulse quality is good.** Infrared channel, timed from `seq`:

- Perfusion index (AC/DC): **1.8%** — solid for a forehead reflective sensor
- Spectral peak **1.250 Hz = 75.0 bpm**, standing **437×** above the median spectral floor
- 148 beats over 113 s = 78.6 bpm, agreeing with the spectral estimate

**PRV is NOT yet trustworthy.** A naive local-maximum detector produced SDNN 158 ms,
RMSSD **263 ms**, intervals 384–1196 ms. Those are physiologically impossible; the
detector is catching dicrotic notches on some cycles. The beat *count* is right, so
the fault is detection, not signal.

**Correction to an earlier assumption.** 64 Hz sampling (15.6 ms quantisation) was
expected to be the main obstacle to PRV. It is not — parabolic peak interpolation
moved RMSSD from 264.3 to 263.1 ms, essentially nothing, because detector error
dwarfs quantisation. **Beat detection quality is the binding constraint**; the
quantisation floor is not yet visible. Quantisation will matter once detection is
fixed, not before.

What PRV needs: an adaptive systolic-upstroke detector with a refractory period,
physiological plausibility gating and outlier rejection; artefact-free windows only;
and recordings longer than 113 s — standard short-term HRV uses ~5 minutes. Report
it as **pulse rate variability from forehead PPG, not ECG-grade HRV**.

---

## Known gaps in this codebase

| Gap | Location | Impact |
|---|---|---|
| ~~Temperature and fuel-gauge mV discarded~~ | fixed 2026-09-04 | The `battery` block is now `telemetry`, carrying `battery_percent`, `fuel_gauge_mv` and `temperature`. The temperature field is the raw 16-bit value — **units unverified** against any InterAxon documentation |
| ~~No PPG drop counting~~ | fixed 2026-09-04 | `ppg.dropped_packets` now counts per channel, as `eeg.dropped_packets` does |
| IMU recorded but never displayed | `src/main.ts` | Motion artefacts invisible to the operator live |
| PPG recorded but never displayed | `src/main.ts` | No live pulse or BPM |
| No band powers | — | Deliberately deferred pending the science team's windowing choice |

---

## Not available over Bluetooth

Calm/focus scores, InterAxon's HSI/horseshoe fit indicator, and hardware timestamps
are computed inside LibMuse and never transmitted.

**But they are obtainable — via LibMuse, not via Bluetooth.** The RDK's macOS
framework (`libmuse_macos_8.0.9`) exposes `Hsi`, `HsiPrecision`, `Artifacts`
(blink / jawClench / headbandOn), `IsGood` / `IsPpgGood` / `IsHeartGood`,
`DroppedEeg`, `Quantization`, `NotchFilteredEeg`, `VarianceEeg` and band powers
for all five bands in Absolute, Relative and Score forms. A comparison harness
lives at `../muse-libmuse-probe`. The distinction to keep straight: unavailable
over the *raw BLE stream* this project reads, not unavailable full stop. The page's "signal stability"
light (`src/session/stability.ts`) is our own derivation and must never be reported
as a fit score.

Its thresholds survived contact with hardware: the `990 µV` rail check fired on a
genuine amplifier saturation (AF8, 2026-09-04 08:48) rather than on normal signal,
and the ±200 µV trace window is correct once electrodes have settled. An early
prediction that a persistent DC offset would peg the traces was **wrong** — the
large excursions seen in the first seconds are a settling transient, not a standing
offset.

---

## Session 2026-09-04 10:04 — LibMuse comparison

Recorded with `../muse-libmuse-probe` (InterAxon LibMuse 8.0.9, macOS framework,
preset p50) and compared against the web-bridge p50 session from 09:22. The
headband accepts one host, so these are two separate sittings: distributions and
event structure are comparable, individual samples are not.

### 1. Our microvolts are 21.2% too large — CONFIRMED

Measuring the quantisation step in LibMuse's output is immune to the
different-sitting problem, unlike comparing standard deviations (which we tried
first and which gave ratios scattered from 0.38 to 3.39 — worthless).

LibMuse's EEG values fall on a perfectly uniform grid:

| | LibMuse | this project |
|---|---|---|
| LSB | **0.4029304029 µV** (smallest gap == median gap, over 3356 distinct values) | 0.48828125 µV |
| zero point | none — raw 0..4095 maps to 0..1650 | midpoint 2048 subtracted |
| observed range | 0.0000 .. 1650.0000 | −833 .. +897 (limits −1000 .. +999.51) |
| full scale | 1650 µV | 2000 µV |

`0.4029304029 × 4095 = 1650.00` exactly. And the headband itself reports
**`afe_gain: 2000`** — so with a 3.3 V ADC full scale, the input-referred full
scale is `3.3 V / 2000 = 1.65 mV`. The hardware, the gain register and LibMuse
all agree on 1650 µV. Our constant (`125/256`, inherited from muse-js) implies a
gain of 1650, and is wrong.

**Conversion:** `ours_uV = 1.21183 × libmuse_uV − 1000.0`

#### ...but "correct" is unsettled, and the RDK does not settle it

Searched for a stated full-scale voltage in `Muse SDK.docx`, every `IXN*.h`
header, the Doxygen HTML, `libmuse_macos_8.0.9.pdf` and the MuseLab guide.
**None of them state it.** `getAfeGain` is documented only as "Gain to apply to
incoming EEG samples"; the 3.3 V rail is our inference from the arithmetic, not
a citation.

Worse, at least three scale constants are in active use:

| source | µV per LSB | implied full scale | ratio to ours |
|---|---|---|---|
| muse-js lineage — what this project uses | 0.48828125 | 2000 µV | 1.000 |
| LibMuse 8.0.9, measured from its own output | 0.4029304 | 1650 µV | 0.825 |
| Krigolson lab (LibMuse value × 1.64498) | 0.662813 | 2714 µV | 1.358 |

The Krigolson lab — which publishes Muse EEG research — instructs users to
subtract the DC component (*"~800 MUSE units"*, matching the 802–819 mean we
measured from LibMuse) and then **multiply by 1.64498** to obtain microvolts.
That is an explicit claim that LibMuse's "microvolts" are *not* microvolts.

**Conclusion: our absolute µV figures are uncertain by roughly ±35%, and no
source available to us resolves it.** Everything relative — the 9.50 Hz peak,
power ratios, spectral shape, artifact multipliers — is untouched by any of this.

**Therefore: do not switch the constant on this evidence.** Record it instead.
Adding `uv_per_lsb` and `zero_code` to the `eeg` block makes every recording
self-describing and rescalable by any consumer, retroactively included. The
question to put to InterAxon, who supplied the RDK, is specific: *what is the
ADC reference voltage and µV-per-LSB for Muse 2 EEG, and does
`getEegChannelValue` return true microvolts or a gain-uncorrected value?*

Sources: [Krigolson lab](https://www.krigolsonlab.com/muse-data-collection.html),
[Mind Monitor technical manual](https://mind-monitor.com/Technical_Manual.php)
(states a 0–1682 range per secondary reporting; the page itself returned 403 and
was not read directly).

**What this does and does not invalidate.** Every absolute µV figure this project
has produced is 21.2% high, and so are the `stability.ts` thresholds derived from
them. Nothing *relative* is affected: the 9.50 Hz alpha peak, all power ratios,
spectral shape and the artifact multipliers are unchanged by a linear rescale.

### 2. LibMuse's timestamps are worse than ours

| | median gap | mean gap | max gap |
|---|---|---|---|
| LibMuse EEG | **0.208 ms** | 3.9057 ms | **2289 ms** |

Samples arrive in bursts stamped on delivery, and LibMuse exposes no sequence
number at all. Its mean is right (256.04 Hz over 138.4 s) but no individual
timestamp can be trusted. Our session file, carrying `seq` on every packet, is
strictly better for reconstructing a regular clock. Do not treat LibMuse
timestamps as a reference.

### 3. LibMuse's artifact flags validate the guided protocol

Anchoring the protocol purely on LibMuse's own `jawClench` flag (last step, fired
130.2–132.9 s) puts the eyes-closed block at 50.2–110.2 s. Independently, its
`blink` flag goes silent from **50.1 s to 110.7 s** — both edges agree within a
second, from two unrelated detectors. The guided protocol, our marker timestamps
and LibMuse's detectors corroborate each other.

### 4. Our stability light — recalibrated, but it is a weak proxy

**A correction.** An earlier pass compared LibMuse's HSI against `stabilityOf()`
computed over whole 20–60 s protocol windows, and concluded our light was
"settling" everywhere. That comparison was wrong: the code runs on a **1-second**
window, and slow drift across a 60 s window inflates std enormously.

Redone properly — 532 channel-seconds of LibMuse EEG, rescaled to our units,
each second scored against the HSI LibMuse reported for that same second:

| LibMuse HSI | n | p5 | median | p90 | p95 |
|---|---|---|---|---|---|
| 1 (good) | 446 | 10.1 | 20.9 | 57.1 | 93.7 |
| 2 (medium) | 74 | 13.7 | 41.2 | 120.6 | 190.7 |
| 4 (bad) | 12 | 34.9 | 105.1 | 264.2 | 306.8 |

**The distributions overlap badly.** The best single threshold separates good from
not-good with only **83.5% accuracy** and lets **92% of bad seconds through**.
Standard deviation tracks signal *spread*; HSI tracks electrode *fit*. They are
not the same measurement and no threshold will make them one.

Change made: `STABLE_STD_UV` 40 → **60 µV**, which keeps 91% of HSI-good seconds
as "stable" where 40 kept 78%. `NOISY_STD_UV` stays at 150 (it already
false-alarms on only 3.1% of good seconds), `RAIL_UV` stays at 990 (it fired on a
genuine saturation), `FLAT_STD_UV` stays at 1.5 (no flat channel was ever
observed to test it).

This strengthens rather than weakens the existing warning: the light is a rough
usability hint, and calling it a fit score would be wrong by measurement, not
just by branding.

### 4b. Superseded: "our stability light is too strict"

LibMuse HSI precision (1 = good, 2 = medium, 4 = bad) reported **1 = good** for
62–100% of every window, including eyes-closed. Our derivation called the
equivalent windows "settling" throughout. `STABLE_STD_UV = 40 µV` is too tight —
and tighter still than it looks, since it sits on our 21%-inflated scale (≈33 µV
in LibMuse units). Different sittings, so this is strong guidance rather than
proof.

Note `IXNMuseDataPacketTypeHsi` produced **zero** packets; only `HsiPrecision`
was emitted. Subscribe to the precision variant.

### 5. Both stacks rank the alpha response the same way

LibMuse `alphaRelative`, eyes-closed vs baseline: TP10 **1.62×**, AF7 1.32×,
TP9 1.04×, AF8 1.01×. Our 1/f-residual test: TP10 **4.07×**, TP9 2.71×,
AF7 1.78×, AF8 1.59×. Both put **TP10 first and AF8 last**; TP9 and AF7 swap in
the middle. The band definitions and normalisation differ, so the magnitudes are
not comparable — the ordering is.

### 6a. PRV now works — the detector was the problem, as suspected

Rebuilt as `src/session/pulse.ts` and validated against the 09:22 p50 session
(infrared channel, timed from `seq`):

| | first attempt | rebuilt detector |
|---|---|---|
| beats over 113 s | 148 | 143 (**75.9 bpm** by count) |
| intervals accepted | — | **138 of 142** |
| SDNN | 158 ms | **41.4 ms** |
| RMSSD | **263 ms** (impossible) | **37.8 ms** |

Those are ordinary resting adult values, and 75.9 bpm matches the independent
spectral estimate of 75.0 bpm.

What actually fixed it: a **local** detection threshold, rebuilt per block of
roughly eight beats from the **median** candidate-peak height. The first version
took one threshold from the whole recording, so it went deaf wherever the pulse
was weaker than average — real PPG amplitude drifts with contact and perfusion.
A single loud artefact was enough to suppress 90% of the beats. Both failure
modes are now regression tests; the original synthetic tests missed them because
they used constant amplitude.

**Channel choice matters.** Infrared is the pulse channel and performs well.
Red is usable but noisier (16 intervals rejected against infrared's 4). *Ambient*
is the ambient-light reference, not a pulse channel — it rejects 36 of 82
intervals and should not be used for PRV.

**Quantisation is now the binding constraint, as predicted.** Snapping beats to
the 64 Hz sample grid instead of interpolating inflates RMSSD from 37.8 to
41.1 ms — a 9% error that sub-sample parabolic interpolation removes. Earlier in
this document quantisation was called second-order; that was true only while
detector error dominated. It no longer does.

**Second validation — different sitting, different capture path.** Run on the
10:04 LibMuse session's PPG (8856 rows at 64.04 Hz, so index/64 is a valid clock;
LibMuse exposes no `seq`):

| | web bridge 09:22 | LibMuse 10:04 |
|---|---|---|
| bpm from accepted intervals | 78.3 | **75.1** (red: 75.6) |
| bpm by beat count / duration | 75.9 | **56.8** |
| intervals rejected | 4 of 142 (3%) | 25 of 130 (19%) |
| SDNN / RMSSD | 41.4 / 37.8 ms | 37.6 / 53.8 ms |
| LibMuse `isHeartGood` = 1 | — | **6% of the time** |

The second recording was a genuinely poor one — LibMuse itself rated the heart
signal good only 6% of the time — and the detector **under-counted beats by ~24%**
on it. It degraded gracefully: the interval-based metrics stayed physiological,
because a missed beat leaves a double-length gap that gating rejects rather than
averages in. Ambient again produced garbage (RMSSD 315 ms), confirming it is not a
pulse channel.

Two rules for the MVP follow directly:

1. **Derive heart rate from accepted intervals, never from beat count over
   duration.** On the poor recording the two disagree by 18 bpm. There is a test.
2. **Expose the rejection rate as a signal-quality indicator.** 3% on a good
   sitting, 19% on a poor one — it tracks quality where our stability light does
   not.

Remaining caveats: both recordings are ~2 minutes (standard short-term HRV uses
~5), this is PRV from forehead PPG, not ECG-grade HRV, and the detector's
sensitivity on poor contact is now a known limitation rather than a suspected one.

### 6b. PPG units differ entirely

LibMuse `getPpgChannelValue` returned values like `[410989, 60557216, 20057069]`
against our raw counts near 79,415. Not yet investigated; do not compare PPG
amplitudes across the two without resolving this.

---

## Bench checklist

1. Dry the forehead. TP9/TP10 must sit on skin, not hair.
2. Preset `p50` — it costs nothing and gives PPG.
3. Pair, then **wait for the traces to settle** before starting the protocol.
4. Run the guided protocol; the spoken cues mean you never need to look at the screen.
5. Save, and analyse from `seq`, not `t_ms`.
