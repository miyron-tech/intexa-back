# CI/CD for Intexa

The frontend lives in `miyron-tech/intexa-front`, the backend in
`miyron-tech/intexa-back`. Each repository has its own `.github/workflows/pipeline.yml`.
Pushes and pull requests build that component and run deployment orchestration tests.
Backend checks additionally use disposable PostgreSQL 17 schemas for billing,
payments, character replacement, video continuation, voice and deployment gating.
No paid provider requests are made in CI.

After checks pass, only `main` can deploy to the `production` environment.
Other branches and PRs never receive deployment credentials.
Protect `main` with the `checks` job as a required check; restrict the production
GitHub environment to `main`. Manual approval is optional.

## Required setup in BOTH repositories

Add these environment secrets under Settings → Environments → production:

| Secret | Value |
| --- | --- |
| DEPLOY_HOST | 5.101.179.107 |
| DEPLOY_USER | SSH account with Docker and /opt access |
| DEPLOY_SSH_KEY | Dedicated Ed25519 private deployment key |
| DEPLOY_KNOWN_HOSTS | Server host key verified over an existing trusted connection |

Authorize the corresponding public key on the server. Application API, database
and payment secrets remain in `/opt/aigenerate/.env`, never in source archives.
Until these secrets are configured, CI checks work but production deployment fails
closed. A repository SSH push key alone cannot configure GitHub secrets or create
pull requests through the GitHub API.

## Server deployment

The checked commit is sent using `git archive` over SSH with strict host checking.
Source goes to `/opt/intexa-releases/<backend|frontend>-<commit>`.
The server uses `/opt/aigenerate/docker-compose.prod.yml` and its `.env`; the checked
component gets an explicit build context and image tag. The other component keeps
its existing image and is not rebuilt or replaced.

A shared server `flock` serializes deployments from BOTH repositories (GitHub
concurrency groups alone do not span repositories). The lock waits up to 50 minutes;
the GitHub deployment timeout is 120 minutes.

Build first, then block new generation submissions via the shared-storage gate.
Drain admitted requests and running/queued jobs for up to 30 minutes, without
interrupting them. History, billing and login stay available. The first installation
against a legacy backend without the gate temporarily stops the frontend to drain
safely. Subsequent deployments have only a brief container replacement interruption.

Before replacement, save a private PostgreSQL custom-format dump, previous env,
and image IDs under `/opt/aigenerate-backups/ci-<component>-<commit>-<timestamp>`.
Check Docker health, private API and public HTTPS homepage/login after switching.
On switch/health failure, restore the previous component image. On rollback failure,
keep the generation gate closed for operator intervention. Database is never
restored automatically, to avoid erasing new payments or users. Use compatible
expand/contract migrations; breaking migrations need planned maintenance.

Successful revisions are recorded separately as
`/opt/intexa-releases/backend-current-revision` and `frontend-current-revision`.
The original source in `/opt/aigenerate` is not updated by component deployments;
operate with the recorded release and its `images.yml` override.
Backups and images are retained without automatic pruning. Monitor disk and keep
off-server backups separately.

## Local checks

Use Node 22/npm 11. Run `npm ci` and `npm run build`. For backend integration
checks use a local/disposable DATABASE_URL, ffmpeg, and the suites listed in the
workflow. Run `node test/deployment-gate.integration.mjs` after backend build.
In either repository run:

```bash
bash -n .github/scripts/deploy-production.sh .github/scripts/deploy-from-ci.sh
python3 .github/scripts/test-deployment.py
```

The deployment tests simulate successful rollout, build/backup failures, failed
switch and health checks, and a failed rollback. They never touch production.

Reference: [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
