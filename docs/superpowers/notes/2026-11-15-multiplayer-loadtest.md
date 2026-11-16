# Multiplayer load test (Task 15)

## Decision 2026-11-16: 60 players per server on 2 vCPU

The user lowered the target after the 100-bot results below.

- The default cap is now **60 players** (`MAX_PLAYERS` = 60). The `MAX_PLAYERS` environment variable can raise it up to 100, but 100 needs a faster single core: the physics runs single-threaded.
- No further physics optimisation for now.
- New load-test criteria (`npm run loadtest`, default `--bots 60`):
  - tick p95 < 16.7 ms (the 60 Hz budget; the old 8 ms target is dropped)
  - dropped ticks < 1 %
  - bandwidth p95 < 50 KB/s
  - RSS growth from minute 3 to the end < 10 % (ruling 2026-11-16; was minute 2, see below)

### 10-minute run with 60 bots (30 walk, 24 drive, 6 ride; server on cores 0,1, bots on 2-5,8-11)

| criterion | measured | limit | ok |
|---|---|---|---|
| tick p95 (p95 of 10 s windows) | 16.26 ms (max 16.88) | < 16.7 ms | yes |
| dropped ticks | 1 of 36000 (0.003 %) | < 1 % | yes |
| bandwidth p95 per client | 23.0 KB/s (worst client 28.0) | < 50 KB/s | yes |
| RSS minute 2 → end (criterion at the time) | 572 → 639 MB (+11.7 %) | < 10 % | **NO** |
| RSS minute 3 → end (criterion now) | 637–639 → 639 MB (≤ +0.3 %) | < 10 % | yes |
| bots still connected | 60 of 60 | all | yes |

The bot process sent 59.5 inputs/s per bot, with an event loop delay p99 of 11 ms.

RSS over the run (time in s : MB):

```
10:660 … 70:692 | 80:538 90:567 120:572 | 130:626 150:637 … 300:638 … 600:639
```

- At about 75 s a large GC shrinks the heap.
- The minute-2 sample (572 MB) falls into the regrowth after that GC.
- From 150 s to the end, RSS stays flat at 637–639 MB (+0.3 %).

So the failed criterion reflected where the baseline sample landed, not a leak. **Ruling (2026-11-16):** the baseline is minute 3 (`loadtest.ts` takes the first sample at t ≥ 180 s and needs `--minutes` ≥ 4 for the RSS row, labelled "RSS minute 3 → end"). The run was not repeated: the recorded RSS above shows only that it stayed at 637–639 MB from 150 s to the end (the 180 s sample itself is not in the excerpt), so minute 3 → end is at most +0.3 %, well below 10 %.

The tick p95 passes, but only just (16.26 ms against 16.67 ms; the worst window was 16.88 ms).

## Earlier: the 100-player target

Date: 2026-11-16. Branch `docs/multiplayer-spec`.

### Result in short

100 bots for 10 minutes against the server on 2 cores: **bandwidth, memory and connection stability pass. Tick time and dropped ticks fail.** The tick p95 is 23 ms (the limit is 8 ms) and 3.7 % of ticks are dropped (the limit is 1 %). The remaining cost is the physics step itself (`WorldSim.step`, 13–15 ms per tick at 100 players). Most of it is Rapier's character controller on the DGM1 terrain. It cannot be fixed without changing the shared physics, which also changes single-player behaviour, so this needs a decision (see "Options").

### Setup

- Machine: AMD Ryzen 5 3600 (6 cores / 12 threads, up to 4.2 GHz), Node 24.
- Server: `NODE_ENV=development PORT=2601 NN_JOIN_PER_MIN=1000 LOG_LEVEL=warn taskset -c 0,1 node --import tsx apps/server/src/main.ts`. This is the same as `npm start -w @nn/server`; `node --import tsx` was used so `--cpu-prof` can be added.
- Bots: `taskset -c 2-5,8-11 npm run loadtest -- --url ws://localhost:2601 --minutes 10`.
  - Deviation from `2-11`: CPUs 6 and 7 are the SMT siblings of CPUs 0 and 1 on this CPU (`lscpu -e`). With the bots on them, the server shared its two physical cores with the bot process. Keeping 6 and 7 free gives the server two whole cores of its own. This is slightly *more* generous than a cloud "2 vCPU", which is often one physical core with two threads.
- Bot mix: per ten bots, 5 walk, 4 drive and 1 rides a bike, so 50/40/10 at 100 bots. All start within 300 m of the spawn.
  - Walkers pick a new target 20–100 m away every 3–8 s, and run half the time.
  - Drivers are teleported next to a parked car (each driver gets its own cars) and press E until they drive. They drive at 0.8 throttle, pick a new steering angle every 1.5–4.5 s, and reverse for 2 s if stuck.
  - Riders do the same with bikes.
  - Everything uses a seeded PRNG (mulberry32).
- During the runs, the mode column showed 40/40 driving and 8–10/10 riding.
- Measurement:
  - `/healthz` every 10 s. The new fields are `ticks`, `droppedTotal` and `rssMb`.
  - Tick p95 is the p95 over the 10 s window p95s.
  - Dropped ticks are counted from the totals between the start and the end of the measurement.
  - Bandwidth: all bytes each bot receives (every websocket message: snapshots and schema patches), per second, from 5 s after its join. The p95 is over all bot-seconds.
  - RSS: minute 2 compared with the end (since the 2026-11-16 ruling: minute 3).
  - Measuring starts 20 s after the last join.

### Runs

| run | bots | tick p95 | dropped | bandwidth p95 | RSS | notes |
|---|---|---|---|---|---|---|
| baseline (per-client snapshot build), 1 min | 100 | 38.3 ms | 16.9 % | 26.1 KB/s | – | bots also on 6,7 |
| + snapshot round built once per round, 1 min | 100 | 25.7 ms | 3.9 % | 33.0 KB/s | – | bots also on 6,7 |
| same, bots off the SMT siblings, 1 min | 100 | 23.0 ms | 1.2 % | 33.5 KB/s | – | |
| + snapshots staggered over the 3 ticks, 1 min | 100 | 23.0 ms | 3.1 % | 32.9 KB/s | – | |
| **full run, 10 min** | **100** | **23.1 ms (max 24.7)** | **3.67 % (1310 of 35652)** | **31.6 KB/s (worst client 36.3)** | **744 → 762 MB (+2.4 %)** | 100/100 connected |
| scaling point, 2 min | 50 | 12.5 ms | 0 % | 18.9 KB/s | – | |

The bot process sent 59.5 inputs/s per bot (the target is 60), with an event loop delay p99 of 11 ms. The load generator was not the bottleneck.

Per-tick split from temporary instrumentation in `stepOnce`, at 100 bots and after the fixes:

| part | ms |
|---|---|
| `sim.step` (average) | 13–15 |
| snapshots (per tick, staggered) | ~1.9 |
| `syncState` (every 3rd tick) | 1.1–1.7 |

At 50 bots the same split is `sim.step` 9.1 ms, snapshots 0.7 ms and syncState 1.1 ms.

### Profile (`node --cpu-prof`, 100 bots)

Baseline, as a share of all server CPU:
- `stepOnce` 88 %. Of that, `WorldSim.step` 56 % and `sendSnapshots` 29.5 %.
  - `buildSnapshot` alone was 23 %: the 2640-lamp loop for every client, `sim.player()` and `Vehicle.saveState()` per client, and so on.
- Inside the step, `Character.applyInput` was 34 %, almost all of it in Rapier's `computeColliderMovement`.
- Bikes 7.6 %, the Rapier world step 11 %.

After the snapshot fix:
- `sendSnapshots` 9.9 %.
- `Character.applyInput` 45 %.
- `RiddenBike.applyInput` 9 %. About 3 % of that is its `notMe` filter predicate (`isSensor` and similar calls from wasm into JS).
- Rapier world step 13 %.
- 9 % idle.

#### Why the character controller is expensive (micro benchmarks, 50 capsules)

| world | µs per `computeColliderMovement` |
|---|---|
| full world (city trimesh + DGM1 heightfield), walking | 105–110 |
| heightfield only | 64–69 |
| the same terrain as a 1 m trimesh | 46–48 |
| flat cuboid ground | 12 |
| full world, standing, zero move | 33 |
| full world, autostep or snap-to-ground switched off | 94–116 (no real difference) |
| full world, no gravity step while grounded | about −25 % per call, −10 % for the whole step |

The cost comes from Rapier's contact and shape-cast work against the composite ground shapes (heightfield + trimesh) under every capsule. Its size does not depend on the size of the heightfield: tiling it into 64 m or 128 m pieces changed nothing. The controller features (autostep, snap-to-ground) do not matter either. In the server the cost is about 150 µs per walker, because walkers slide along walls and push past each other. Bikes cost about the same per rider. With 50 walkers, 10 riders, 40 driven cars and the world step, that adds up to 13–15 ms.

### What was changed

- `snapshotRound(sim, events, slotOf)` and `snapshotFor(round, sim, id, interest, ack)` in `@nn/shared/sim`.
  - Walkers, riders, moving bikes, cars and tipping lamps are collected once per round and filtered per client.
  - The lamp loop now runs over `lampsDown()` instead of all 2640 props.
  - `buildSnapshot` is kept as a wrapper and its output is unchanged; the existing snapshot and online-session tests pass.
- Room:
  - Snapshots are staggered. A client's turn is the tick phase `slot % 3`, so every client still gets 20 Hz and the snapshot work is spread over all ticks.
  - The events of the last 3 ticks are kept in a ring, so each client gets every event exactly once.
- `/healthz` additionally reports `ticks`, `droppedTotal` and `rssMb`.
- `NN_JOIN_PER_MIN`: raises the per-address join limit, **in dev only**. In production the limit stays at 5/min (test `config.test.ts`). The load test needs it because all bots join from 127.0.0.1.

### Options (decided: option 1, see above)

1. **Lower the capacity claim.** At 50 players the tick p95 is 12.5 ms with no dropped ticks; the p95 limit of 8 ms is still missed. The 8 ms target looks reachable at about 30 players on this CPU, and cloud cores are usually slower.
2. **Relax the criterion.** For example: tick p95 below the 16.7 ms tick budget, and fewer than 1 % dropped ticks. Neither holds at 100 players today either; the average step is already 80–90 % of the budget.
3. **Cheaper character physics in `@nn/shared`.** For example, no gravity step while grounded (−10 %), or keeping the terrain out of the controller query and handling the ground analytically. This changes both client and server, so the single-player feel would need a drive-check and ride-check re-run. None of the options seen so far gives the 2× or more that is needed.
4. **Smaller levers, worth about 1–2 ms in total:**
   - cache the bike filter predicate;
   - make `syncState` incremental (it walks all 2586 cars every 3 ticks: 1.1–1.7 ms);
   - `CAR_PHYSICS_NEAR` 60 m around walkers. Sleeping parked cars are cheap, so this lever is small.
