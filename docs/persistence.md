# Data persistence: SQLite + Litestream

## The problem

CIQ stores all of its durable state — users, auth sessions, survey records,
biometric baselines, and the seeded demo data — in a **single SQLite database**
at `app/backend/data/ciq.db` (`db.py`), in WAL mode.

That file lives on the **container's ephemeral writable layer**. Nothing is
mounted over it. On Azure Container Apps the filesystem is wiped on every:

- new revision (`azd up` / any image or config change),
- manual restart,
- platform-initiated move or scale event.

So before this change, **every deployment silently reset the database** — all
registered users, completed assessments and report history were lost, and the
app re-seeded only the bootstrap admin/guest accounts. The "From your last
check-in" panel on the landing page, which reads back `prompt_info.agentResponse`
from history, would come up empty after any redeploy.

## Why Litestream (and not the alternatives)

The app is **pinned to exactly one replica** (`infra/main.bicep`,
`containerMinReplicas: 1` / `containerMaxReplicas: 1`) because auth sessions and
in-memory `RTMiddleTier` state are per-process. That single-writer constraint is
what makes the cheapest option also the most robust.

| Option | Marginal cost | App code change | Notes |
|---|---|---|---|
| **Litestream → Blob** ✅ | ~cents/month | **none** | Keeps SQLite + WAL on fast local disk; streams WAL to blob; restore on boot. Single-writer is exactly its supported model. |
| Azure Files volume mount | <$1/mo + tx | drop WAL | SQLite over SMB + WAL is officially unsupported (needs shared-memory mmap); locking is flaky; per-query network latency. |
| DIY blob backup/restore | cents/month | ~40 LOC | Coarser, larger data-loss window on a hard crash. |
| Postgres Flexible Server | ~$13–15/mo | full rewrite | The right answer *if/when* we ever run >1 replica. Overkill today. |

**Litestream** is a single open-source Go binary that continuously replicates a
SQLite database to object storage and restores it on startup. It assumes one
writer — which we already are — and changes **zero application code**.

### Cost (real numbers)

Litestream itself is free (Apache-2.0). The only cost is the Azure Blob traffic,
on current Hot LRS rates ($0.0184/GB-mo storage, $0.05 per 10k write ops):

- **Storage:** snapshot + WAL ≈ a few hundred MB → **~$0.01/mo**.
- **Write ops:** the app writes only during surveys/logins (bursty), so
  realistically **~$0.10–0.70/mo**. (Pathological worst case — a write every
  second, 24/7 — would be ~$13/mo, which this workload never approaches.)
- **Restore reads / egress:** only on boot, within the free egress tier → **$0**.

Net: **pennies per month**, rounding error against the Container App and Azure
OpenAI spend.

## How it works here

```
boot:  litestream restore  ──(if a backup exists)──►  rebuild /app/data/ciq.db
run:   litestream replicate -exec "gunicorn …"        stream WAL → blob, supervise app
stop:  SIGTERM ─► Litestream final sync ─► exit       (planned redeploys lose nothing)
```

- **`app/Dockerfile`** copies the `litestream` binary from the official image and
  runs **`app/backend/entrypoint.sh`** as the container command. **Pin ≥ 0.5.1**:
  Azure managed-identity auth landed in Litestream **0.5.0**, and this design uses
  MI only (`allowSharedKeyAccess: false`, no account key), so 0.3.x cannot
  authenticate and replication silently fails. 0.5.x also renamed the config
  `replicas:` array to a single `replica:` object (0.5.0 briefly dropped
  `-if-replica-exists`, restored in 0.5.1).
- **`entrypoint.sh`** restores the DB from blob (a no-op on the very first
  deploy via `-if-replica-exists`), then launches gunicorn *under*
  `litestream replicate -exec`, so writes stream out continuously and a final
  sync runs on shutdown.
- **`app/backend/litestream.yml`** maps the local DB path to the replica URL,
  which is injected as `LITESTREAM_REPLICA_URL`.
- **`infra/main.bicep`** provisions a dedicated, always-on storage account
  (`<st>ls<token>`) with one private container (`litestream`), grants the
  backend's **user-assigned managed identity** the **Storage Blob Data
  Contributor** role, and sets `LITESTREAM_REPLICA_URL` =
  `abs://<account>@litestream/ciq`. Auth uses that managed identity
  (`AZURE_CLIENT_ID` is already exported) — **no account keys**; the account has
  `allowSharedKeyAccess: false`.

### Important implementation details

- The local `data/*.db*` files are **`.dockerignored`** so they never ship in
  the image — `litestream restore` refuses to overwrite an existing file, and a
  stale baked-in DB would break the restore.
- **WAL mode stays on** (`db.py`/`db_init.py`). Litestream requires it and it's
  fast on local disk. Restore runs *before* the app starts, so `init_db`'s
  `CREATE TABLE IF NOT EXISTS` / `INSERT OR IGNORE` safely no-op against the
  restored data.
- **Data-loss window:** replication is async (~1s). A hard crash could lose the
  last ~1s of writes; graceful redeploys (SIGTERM) lose nothing.

## Local development

Unaffected. `python app/backend/app.py` and `npm run dev` don't go through the
container entrypoint. Even in local Docker, with `LITESTREAM_REPLICA_URL` unset
the entrypoint runs the app directly with no replication.

## When to revisit

Move to **Azure Database for PostgreSQL** only when we need to run **more than
one replica** (horizontal scale). At that point the single-writer assumption
behind both the current in-memory session state *and* Litestream no longer
holds, and a real networked database becomes necessary.
