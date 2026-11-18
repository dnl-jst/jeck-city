# NPC load test (Task 15)

Date: 2026-11-18. Branch `feat/npcs`. Machine and setup as in `2026-11-15-multiplayer-loadtest.md`: AMD Ryzen 5 3600,
server `taskset -c 0,1`, bots `taskset -c 2-5,8-11`, `npm run loadtest -- --url ws://localhost:2631 --minutes 10`
(40 bots: 20 walk, 16 drive, 4 ride, all within 300 m of the spawn).

Caveat: during these runs a dev server (not pinned to cores) with a human player and a browser ran on the same machine.
They compete with the test server for cores 0 and 1, so tick times are somewhat noisy (single spikes up to 26 ms).

## Baseline without NPCs (`NN_NPCS=off`, 4 min)

| criterion | measured |
|---|---|
| tick p95 | 12.30 ms (max 13.22) |
| dropped ticks | 0.153 % |

## Runs with NPCs

| run | change | tick p95 (max) | dropped | NPCs min / mean | NPC KB/s | brake |
|---|---|---|---|---|---|---|
| 1 | first version | 21.13 ms (113) | 3.13 % | 175 / 205 | 0.95 | density, 14/10 ms |
| 2 | hot paths (area scans, lookahead from the plan, player states once per tick) | 18.01 ms (20.4) | 0.50 % | 206 / 225 | 0.67 | density, 14/10 ms |
| 3 | traffic checks staggered by distance, person bodies ≤ 25 m, surplus dissolved | 14.51 ms (15.5) | 0.26 % | 115 / 157 | 0.82 | density, 14/10 ms |
| 4 | brake 15 / 12.5 ms | 16.10 ms (24.2) | 0.39 % | 88 / 153 | 0.80 | density, 15/12.5 ms |
| 5 | brake lowers a cap on the NPC count | 16.46 ms (25.8) | 1.13 % | 105 / 179 | 0.74 | cap, 15/12.5 ms |

All runs: bandwidth p95 per client 15–18 KB/s (< 50), RSS stable, 40 of 40 bots connected.

## Profile (run 5 build, 3 min with `--cpu-prof`)

Of the busy time: the NPC director ~4.5 %, the NPC bodies' sync ~2 %, the per-client feed ~0.6 % of the total
(≈ 1.7 ms per tick at 40 players). The rest is the players' physics (`applyInput`: character controllers, as before
the NPCs) and the snapshot round.

## Result

- Met: tick p95 < 16.7 ms (run 5: 16.46), bandwidth, RSS, connections, NPC messages < 2 KB/s per client.
- Not met under this full load: **at least 150 NPCs** throughout (run 5: 105–360, mean 179) and, in run 5, dropped
  ticks < 1 % (1.13 %, from one spike).
- The load brake now caps the NPC count by the tick time: with fewer players or a faster core there are more NPCs (up
  to NPC_MAX 400); a full 40-player server on 2 cores carries roughly 100–200.
- The planned 20-bot run (does the brake stay at full density?) was not made; with 40 bots the cap stayed at
  0.8–0.9 for the first two minutes, while the area filled.
