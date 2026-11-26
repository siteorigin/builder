# Estimating a run

Read when the user asks how long the run or the drain will take.

Work from this run's measured throughput, not issue counts alone: issues landed per hour, and the time from a pick to its batch's last landing. No `/work-batch` run has been measured on this repository yet, so until one has, treat these as rough starting points and say so:

| Step | Time | Source |
|---|---|---|
| Pick (`/next-batch`) | about 12 minutes | Daintree, 2026-10-22; this repository's backlog is much smaller, so expect less |
| Sync, create worktrees, launch | about 12 minutes for 16 issues | Daintree, 2026-10-22 |
| One agent's scoped work, reviewed and landed | 27 to 65 minutes | Seven parallel agents on this repository, 2026-11-23, not run through `/work` |
| The agent seeing its PR's CI through | a few minutes when the first run is green; each fix adds a run | `Unit tests` on `ubuntu-latest`, not yet timed on GitHub |
| `/merge-prs` | about 45 minutes for 16 PRs in trains | Daintree, 2026-10-22; PRs arrive with their CI finished, but hot-file rebases are likely |

Replace these with this repository's own numbers once a run has finished.

The flow hides the pick and the merge, so while there are enough ready issues to keep every slot busy, throughput is about the slot count over the average unit time, `/work` and its CI watch together: 8 slots at 50 minutes is about 10 issues an hour.

Then say what bounds it:

- **By count:** open issues ready to work, divided by that throughput.
- **By dependencies:** a chain needs one agent-plus-merge cycle per wave (its slowest agent plus a merge), whatever the batch size, because a wave starts only once the one before it has merged. The longest chain (a tracker issue's wave table, or the pick's Deferred list) sets the floor. The estimate is the larger of the two.
- **New issues:** count issues filed since the run started, closed ones included (`gh issue list --repo <owner>/<repo> --state all --search "created:>=<run start, YYYY-MM-DD>" --limit 1000 --json number,createdAt,state`, then filter by `createdAt`). When they arrive faster than the run closes them, the drain has no end in sight: say so.
- **Usage:** a machine scaled down or out on its weekly limit (SKILL.md, Usage limits) runs fewer slots until its reset, and a run held on usage makes no progress until then: count the slots that can actually run.
- **Never picked:** issues waiting on a human answer, and tracker issues, don't count.
