# ADR 0010: Builds in the user's own GitHub Actions

Status: accepted (2026-10-28); end-to-end on GitHub pending the first real build

## Context

Builds are the VM's heaviest load: on 2026-10-24 a build took 71 s on a quiet
VM and 676 s with 20 sites busy (227 s once sites and builds had their own CPU
groups). The VM has 2 CPUs and Oracle's free tier allows no more. GitHub
Actions gives every repository free build machines (2-4 CPUs, 7-16 GB):
unlimited minutes on public repositories, 2,000 a month on private ones.
GitHub's terms allow running a repository's own builds in its own Actions;
running other people's builds in ours they likely don't (ADR 0002).

## Decision

A project can choose **Build on: GitHub Actions** (opt-in; AutoDeploy's sandbox
stays the default). Then:

1. The GitHub App (with Actions and Workflows write) opens a pull request adding
   `.github/workflows/autodeploy.yml`; the project can switch only once it is
   on the project's branch.
2. For each build the worker records what the API will accept for that attempt
   (a random nonce, the repository, an output cap) in Valkey and starts the
   workflow (`workflow_dispatch`) with the build settings as its one input.
3. The workflow runs `ci-runner.cjs`: it claims the attempt from the API,
   receives the project's variables (masked in GitHub's log; none for a pull
   request from a fork), applies a repair's patch if any, runs the same
   install-and-build script as the sandbox, streams its log, and sends the
   built checkout back in parts of at most 32 MiB (no `.git` or caches;
   `node_modules` only where a server needs them).
4. The worker relays the log into the deployment's log, cancels the run when
   the deploy is cancelled or out of time, then lists the archive before
   unpacking anything and unpacks it into an empty folder. From there, the
   site check, storing and going live are exactly as for a sandbox build.

**Trust.** Every call to `/ci/v1/*` carries the job's GitHub OIDC token,
verified against GitHub's published keys (issuer, audience = our API,
lifetime), and must be for the project's repository, from its
`autodeploy.yml`, from a dispatched run, with the attempt's nonce; the first
run to call claims the attempt. No secret is stored in the user's repository.
The build itself never sees the job's token or the nonce.

**Limits.** Log lines and length, part size and count, and the compressed
output are capped per attempt (`CI_MAX_OUTPUT_MB`, 400). Before unpacking, the
archive is refused if a path leaves the checkout, an entry is a hard link or
device, a file sits under one of the archive's own symlinks, or it would
unpack past `CI_MAX_UNPACKED_MB` (3 GiB: a compressed bomb can't fill the
disk). The output comes through the API rather than a direct upload link to
object storage because a link can't enforce a size, and one workflow filling
the free 10 GB would break storage for everyone.

**The runner is plain JavaScript** (`packages/github/src/ci-runner.cjs`),
embedded in the workflow as text through a generated constant: a compiler's
rewriting (Vite's `import()`, esbuild's `__name`) would otherwise change what
runs on GitHub. A test keeps the two identical and runs the embedded script
against the real API routes.

## Consequences

- Builds can leave the VM entirely; the VM still runs the site check, the
  storing and the serving.
- Variables reach GitHub's machine for the length of a build, masked in its
  log, exactly as they reach the sandbox; a fork's pull request gets none.
- A build waits for a GitHub runner (`CI_START_TIMEOUT_S`, 10 min) and uses the
  repository's Actions minutes.
- Updating the workflow means a new pull request (`CI_WORKFLOW_VERSION`).
