#!/usr/bin/env bash
# infra/deploy/lib/remote.sh against a stand-in VM on this machine, through an
# `ssh` that drops the connection on purpose: before running the command
# (nothing happened) or after (it ran, but the reply never arrived).
# Run: bash tests/deploy/remote.test.sh   (also run by tests/unit/deploy-remote.test.ts)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
lib="$here/../../infra/deploy/lib/remote.sh"
work=$(mktemp -d)
trap 'pkill -f "$work/" 2>/dev/null; rm -rf "$work"' EXIT
bin="$work/bin"
mkdir -p "$bin" "$work/vm"

# ---- the stand-in VM: commands run here, sudo is a no-op, and systemd-run
# starts the job in the background, remembering its pid for systemctl.
cat >"$bin/ssh" <<'EOF'
#!/usr/bin/env bash
# Drops follow $STATE/plan, one word per call: ok | before | after.
n=$(($(cat "$STATE/calls" 2>/dev/null || echo 0) + 1)); echo "$n" >"$STATE/calls"
mode=$(sed -n "${n}p" "$STATE/plan" 2>/dev/null); mode=${mode:-ok}
while [ "${1:-}" = -o ]; do shift 2; done
shift # the target
[ "$mode" = before ] && exit 255
if [ "$mode" = after ]; then bash -c "$*" >/dev/null 2>&1; exit 255; fi
exec bash -c "$*"
EOF
cat >"$bin/sudo" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF
cat >"$bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
unit=; while [[ "${1:-}" == --* ]]; do [[ "$1" == --unit=* ]] && unit=${1#--unit=}; shift; done
echo "$unit" >>"$STATE/starts"
nohup "$@" >/dev/null 2>&1 &
echo $! >"$STATE/$unit.pid"
EOF
cat >"$bin/systemctl" <<'EOF'
#!/usr/bin/env bash
# systemctl is-active --quiet <unit>
pid=$(cat "$STATE/$3.pid" 2>/dev/null) && kill -0 "$pid" 2>/dev/null
EOF
cat >"$bin/stat" <<'EOF'
#!/usr/bin/env bash
# stat -c %s <file>
[ -f "$3" ] && wc -c <"$3" | tr -d ' ' || exit 1
EOF
cat >"$bin/install" <<'EOF'
#!/usr/bin/env bash
# install -D -m <mode> <source> <dest>
mkdir -p "$(dirname "$5")" && cat "$4" >"$5" && chmod "$3" "$5"
EOF
chmod +x "$bin"/*
export PATH="$bin:$PATH" STATE="$work/state" ON_VM_LOGS="$work/vm/logs" ON_VM_POLL=0.2 RETRY_PAUSE=0
target=vm
# shellcheck source=../../infra/deploy/lib/remote.sh
source "$lib"

fails=0
check() { # check <description> <condition…>
  if "${@:2}"; then echo "  ✓ $1"; else echo "  ✗ $1"; fails=$((fails + 1)); fi
}
fresh() { # fresh <plan words…>: a new run with this drop plan
  rm -rf "$STATE"; mkdir -p "$STATE"; printf '%s\n' "$@" >"$STATE/plan"
}
calls() { cat "$STATE/calls" 2>/dev/null || echo 0; }

echo "remote"
fresh before before ok
out=$(remote 'echo hello' 2>/dev/null); rc=$?
check "gets through two drops" [ "$rc" = 0 ] && [ "$out" = hello ]
check "…in three calls" [ "$(calls)" = 3 ]

fresh ok
remote 'exit 3' 2>/dev/null; rc=$?
check "a command that fails on the VM is not retried" [ "$rc" = 3 ] && [ "$(calls)" = 1 ]

fresh before before before before before
remote 'echo never' >/dev/null 2>&1; rc=$?
check "gives up after 4 tries, saying the connection failed" [ "$rc" = 255 ] && [ "$(calls)" = 4 ]

echo "remote_in"
fresh before after ok
printf 'line one\nline two\n' >"$work/input"
remote_in "$work/input" "cat >$work/vm/received" 2>/dev/null; rc=$?
check "sends the input again after a drop, whole" [ "$rc" = 0 ] && cmp -s "$work/input" "$work/vm/received"

echo "on_vm"
cat >"$work/step.sh" <<'EOF'
for i in $(seq 1 25); do echo "line $i"; sleep 0.05; done
EOF
# A drop on every other call or so, both kinds, including right after the start.
fresh ok after before ok after ok before ok ok after ok before ok after ok ok before after ok ok \
  before ok after ok ok before ok after ok before ok ok after ok before ok
export RUN_ID=t1
out=$(on_vm build "$work/step.sh" 2>/dev/null); rc=$?
check "a long step finishes through drops" [ "$rc" = 0 ]
check "it ran exactly once" [ "$(wc -l <"$STATE/starts" | tr -d ' ')" = 1 ]
expected=$(for i in $(seq 1 25); do echo "line $i"; done)
check "its log arrived complete, in order, nothing twice" [ "$out" = "$expected" ]
if [ "$rc" != 0 ] || [ "$out" != "$expected" ]; then
  echo "    exit status $rc; log received:"; printf '%s\n' "$out" | sed 's/^/      | /' | head -40
fi

fresh ok
cat >"$work/fail.sh" <<'EOF'
echo "building"; exit 7
EOF
export RUN_ID=t2
out=$(on_vm build "$work/fail.sh" 2>/dev/null); rc=$?
check "a failing step's exit status comes back" [ "$rc" = 7 ] && [ "$out" = building ]

echo
if [ "$fails" = 0 ]; then echo "all passed"; else echo "$fails failed"; exit 1; fi
