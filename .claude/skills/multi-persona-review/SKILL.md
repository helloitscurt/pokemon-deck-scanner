---
name: multi-persona-review
description: Project-tailored version of all-persona-review for pokemon-deck-scanner — review a diff or plan doc through seven lenses (Architect, SWE, QA, DBA, DevOps, SRE, Security), tuned to this app's actual hand-rolled migrations, single-admin self-hosted deploy, and public-sharing threat model. Takes precedence over the global all-persona-review fallback. Use when asked to "review with personas", for a multi-persona review, or before committing a design doc.
---

When asked to "review with personas" (or a plan/commit says "multi-persona review"), apply
**all seven lenses below in one pass**, inline in the main conversation — **not** as spawned
subagents. The personas are lenses on one read of the diff, not independent investigations, so
splitting them into isolated subagents would lose the cross-referencing between findings.

**Tag findings** `PERSONA-N` (e.g. `DBA-1`, `QA-2`) in severity order (HIGH/MED/LOW). For a
design doc being finalized, add a findings-index table at the end
(`Tag | Sev | Finding | Addressed in`). For a quick commit review, a flat list grouped by persona
is enough.

Not every persona produces a finding on every change — a pure doc edit has nothing for DBA to
say. State "clean" for a persona with nothing to add rather than inventing a nitpick.

**If the change touches the live card scanner** (camera capture, OCR, a vision provider, scan
queue/rate-limiting), fold in the [scanner-vision-review](../scanner-vision-review/SKILL.md) lens
as an eighth pass tagged `M`, rather than improvising a domain lens inline.

### Architect (`A`) — does this fit the system's shape?

Concerned with **coupling, boundaries, and whether the change induces the RIGHT dependency**, not
code style.

Ask:
- Does this change need to touch the file it's touching, or does it reveal a missing seam?
- Is a semantic left unspecified that the code will silently resolve one way?
- Does a lookup ordering create a self-defeating loop?
- Does a broad match silently swallow a case that matters?
- Is this the correct historical source of truth, or a derived cache masquerading as one?

**When to flag vs. stay quiet:** flag when the change teaches the codebase a NEW pattern (new
table, new cross-service dependency, new precedence rule). Stay quiet on cosmetic naming or where
an existing pattern is being correctly repeated.

### SWE (`S`) — is the code correct, minimal, and consistent with itself?

The generalist code-quality lens: correctness bugs that aren't architectural, dead code, redundant
computation, naming that misleads.

Ask:
- Does a computed value duplicate data already available elsewhere?
- Is there a hot-path cost that a cold path already pays and shouldn't?
- Does a new value need type coercion the surrounding code already established a pattern for?
- Is a new resource (thread, connection, subprocess, camera/device handle) started without the
  shutdown/timeout discipline the rest of the file uses? A live `getUserMedia` stream or
  `useRef`-held device handle that outlives its component is this app's actual recurring version
  of this bug (see the camera-remount fix in `DeckCardScanner.jsx` history) — check it explicitly
  on any effect/ref change in that file.
- Did MY OWN earlier edit in this session leave an orphan?

**When to flag vs. stay quiet:** flag anything a `git blame` six months from now would read as
"why does this duplicate that." Stay quiet on style preferences the codebase doesn't already
enforce.

### QA (`Q`) — would a test have caught this, and does one exist?

Not "are there tests" — **would a test that asserts on the REAL DATA SHAPE have caught this
specific bug**.

Ask:
- Does the test suite exercise the actual VALUES that matter, or a shape that happens to pass?
- Can this test run in CI (`backend-tests.yml`, `frontend-card-system.yml`), or does it silently
  skip?
- Is the boundary condition tested, not just the happy path?
- Does a "should never happen" branch have a test proving it doesn't, or is it unverified
  defensive code?
- Would this test have caught the ACTUAL historical bug, if it existed before the bug was fixed?

**When to flag vs. stay quiet:** flag when a fix ships with NO test that would fail without the
fix. Stay quiet on coverage-percentage nitpicking.

### DBA (`B`) — is the schema change correct for how THIS app actually migrates?

This app has **no Alembic and no down-migrations**. Schema changes are a hand-rolled, append-only
list of idempotent statements in [`backend/database.py`](../../../backend/database.py) (search
`Apply any schema migrations that cannot be handled by create_all`), executed in order every time
the container starts. The generic "run EXPLAIN ANALYZE" framing doesn't fit a self-hosted
single-Postgres-instance app with no read replicas and low query volume — don't chase execution
plans here.

Ask instead:
- Is a new statement **appended to the end** of the list, not inserted earlier (ordering is
  significant — it replays on every startup, oldest-first)?
- Is it idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, or equivalent) so a
  container restart with no pending change doesn't error?
- If it adds a `NOT NULL` or changes a default, does it backfill existing rows correctly — this
  runs against a live production database with real rows, not a fresh schema?
- Does a new column/table also get picked up by `create_all` for a **fresh** install (new users
  bootstrapping from zero), not just the ALTER path for existing installs?

**When to flag vs. stay quiet:** flag any new statement in that list, or any schema change made
directly via the ORM models without a corresponding ALTER for existing installs. Stay quiet on
query-shape/index concerns unless a specific query is already known to run hot (scan queue
polling is the one path worth checking against real row counts; general CRUD is not).

### DevOps (`D`) — will this actually run on THIS deploy, and survive a restart?

This app deploys via `docker-compose` (Postgres + backend + frontend/nginx containers) with
CI in `.github/workflows/` (`backend-tests.yml`, `frontend-card-system.yml`, `release.yml`,
`version-check.yml`). There is no separate migration-gate step — migrations apply automatically
on backend container startup (see DBA above), so "is the migration gated in CI the same way prior
ones were" doesn't apply the way it would with a real migration tool.

Ask:
- Does this change run safely the FIRST time an already-running production container restarts
  with this code — not just on a fresh `docker-compose up`?
- Is a new env var actually threaded through `docker-compose.yml` and `.env.example`, not just
  read in Python with no documented default?
- Is a new service/dependency added to the CI workflow that would need to exercise it
  (`backend-tests.yml` vs `frontend-card-system.yml`), or does it silently go untested in CI?
- Does `scripts/check-version.mjs` / `release.yml` need to know about this change (version bump,
  changelog), or is it purely internal?

**When to flag vs. stay quiet:** flag any new env var, container, or dependency that isn't traced
to `docker-compose.yml`/`.env.example`/a CI workflow. Stay quiet on deploy-mechanics unchanged by
this diff.

### SRE (`R`) — if this breaks, does the ONE admin running this instance find out?

This is a self-hosted app for a single administrator, not a paged on-call service — reframe away
from "3am paging" and "blast radius across users." The real question is whether a silent failure
(stuck scan queue, exhausted Gemini daily quota, a background sync job that stops) ever surfaces
anywhere the admin would see it (logs, UI state, an error banner), or just quietly stops working.

Ask:
- Is there a monitoring gap between "the container is up" and "the feature is actually working"?
- If `gemini_rate_limit.py`'s penalty/quota state trips, is that visible to the admin, or does the
  scanner just silently stop returning results with no explanation?
- Does a partial/degraded state (one provider down, one card failing to resolve) get surfaced per
  item, or does it fail the whole batch/session opaquely?
- If the write path (DB write, image cache write) fails, does the read path degrade gracefully or
  throw an unhandled error the admin has to dig a stack trace out of?

**When to flag vs. stay quiet:** flag any new background job, queue, or external-API dependency
that has no visible signal when it silently stops. Stay quiet on one-shot scripts/tools with no
ongoing operational existence.

### Security (`X`) — what does an untrusted input reach, and is data private by default?

This app's actual threat model is documented, not hypothetical: it optionally sits behind
reverse-proxy auth (see [`docs/REVERSE_PROXY_AUTH.md`](../../../docs/REVERSE_PROXY_AUTH.md)) but
also enforces its own sharing model afterward — public profiles are opt-in, binders are shared
individually, and collection values are hidden unless explicitly enabled. `scan_providers.py`
already reasons explicitly about SSRF (a user-supplied provider base URL would let any account
point the server at an arbitrary host) — match that level of explicit reasoning rather than
generic OWASP checklist items.

Ask:
- Does this change interpolate a value into SQL, a shell command, or rendered output without the
  existing escaping/parameterization pattern?
- Is a credential (API key, session token) handled the way the ones next to it are?
- **Is a new field or endpoint default-private?** Does a new query that reads shareable data
  (binders, collection values, profile fields) actually join through the visibility/ownership
  check, or does it filter after the fact (or not at all) — the three-gate model (admin enables
  public profiles → trainer publishes → binder shared individually) needs to hold at the query
  level, not just the route level.
- Would a network fetch (vision provider, Bulbapedia scrape, exchange-rate API) or user input
  return attacker-shaped data this code trusts implicitly?
- Given this app usually runs behind a proxy but is sometimes exposed directly, is a
  "vulnerability" exploitable in either deployment mode? Name which one explicitly.

**When to flag vs. stay quiet:** flag genuine injection/credential gaps in new code paths, and ANY
new read path over shareable user data that doesn't visibly go through the sharing/visibility
check. Stay quiet on generic security best-practices with no realistic exploitation path here —
say so explicitly.
