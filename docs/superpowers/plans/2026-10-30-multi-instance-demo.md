# Multi-instance demo implementation plan

> Execute inline with `executing-plans`; use `verification-before-completion` before delivery.

The demo runs three HTTP APIs through Nginx, two consumers, two publishers and
one reference worker. The existing two Docker commands stay the same.

Nginx balances HTTP requests. PostgreSQL coordinates financial effects. Runtime
processes share a compiled image, each with its own healthcheck, pool and shutdown.
Domain rules, migrations, RE-03 and message contracts remain unchanged.

The stack uses the existing Bun/NestJS/PostgreSQL/LocalStack setup and adds
Nginx unprivileged 1.30.6. Requirements come from the user request of 2026-10-30
and challenge §§8, 12 and 13.

## Global constraints

- Fixed topology: api-1/2/3, consumer-1/2, publisher-1/2, pending-worker.
- Nginx Alpine digest: sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03.
- Only Nginx publishes 127.0.0.1:${DEMO_PORT:-3000}; smoke has no dependencies.
- Shared round-robin upstream with Docker DNS; connect timeout 1s, at most 3 tries.
- No cache or non_idempotent retry; proxy owns X-Demo-Upstream; JSON access logs.
- Smoke SQL queries are read-only. Each run uses unique identities and explicit deadlines.

## Review focus

- Backend recreation changes its address: verify redistribution without proxy restart.
- A POST already forwarded must never be retried by the proxy.
- All APIs down: readiness 503, proxy liveness 200; proxy down: smoke fails.
- Two concurrent BETs must actually reach distinct processes.
- Fifty concurrent replays must reach all three APIs without new ledger/events.

## Tasks

- [x] Update smoke assertions first: readiness identifies all DNS-resolved APIs,
      distinct BET backends, 50 historical replays across all APIs, unchanged effects.
- [x] Implement Compose/Nginx; validate config, clean startup, two smokes,
      unchanged container IDs, repeated startup, graceful restart.
- [x] Extend CI with degraded operation, backend recreation, complete smoke after
      recovery, unavailable proxy, all APIs down and diagnostic artifacts.
- [x] Update README, quickstart and architecture; verify docs and graph update.
- [x] Run format:check, typecheck, lint, build and full suite. Review changes,
      commit/push feature branch and open new PR. Never merge.

Remote CI results are tracked in PR #2.

## Execution record

- Base: origin/main 8bd7ae1; clean working tree; feature branch created in place.
- Local Docker validation uses a separate project/port to preserve the running demo.
- Graph query located compose.demo.yaml, docker/smoke.ts and operational docs;
  CI located with restricted file inventory.
- Expected initial failure: existing gateway readiness lacked X-Demo-Upstream.
- Docker Desktop Linux, Bun 1.4.4, PostgreSQL 18.3, LocalStack 4.14.0,
  Nginx 1.30.6 (image user 101). Project dwp-multi-validation, host port 3100.
- Clean startup: eleven healthy continuous services, both initialization jobs
  exited zero. Two consecutive smokes preserved all nine runtime container IDs;
  repeated startup and graceful restart followed by smoke passed.
- Stopped api-3: twelve readiness requests reached the other two backends.
  Forced recreation changed 172.22.0.11 to 172.22.0.13 with the same Nginx
  container; readiness and a complete smoke reached all three again.
- With Nginx stopped, the smoke failed. With all APIs stopped, readiness returned
  503 and proxy liveness returned 200. Recovery and a complete smoke passed.
  The final rebuilt image passed two further smokes with unchanged runtime
  container IDs and nginx -t.
- Each full smoke verified distinct BET backends, 50 concurrent historical
  replays across three APIs, read-only SQL, Inbox duplicate, ten published events
  matching Outbox payloads and final ledger reconciliation at 25.00 BRL.
- Independent review: no blocking findings. YAML parsed and all seventeen CI
  shell steps passed bash -n. Access logs parsed as JSON with routing/timing only.
- format:check, typecheck, lint (including architecture), build and four
  documentation tests passed. Full suite: 487 pass, 0 fail, 38 files (469.86s).
- PR #2 was opened as a draft while CI ran. Quality, startup, two smokes and
  restart passed on the first run. The recreation harness failed because the
  runner Docker rejected static IP assignment on automatic subnets. The harness
  now allocates an endpoint dynamically and still requires the recreated API to
  have a different IP.
- The [final CI run](https://github.com/self1027/tt-junglegaming-backend/actions/runs/41071370237)
  passed quality, docker-smoke and integration. The remote suite passed all 487
  tests across 38 files with zero failures (511.60s). PR #2 was marked ready for
  review without merging.
