# shellcheck shell=bash disable=SC2154 # $target and $RUN_ID come from the script that sources this
# Talking to the VM over SSH in a way that survives a dropped connection.
# Sourced by ship.sh (and the tests); needs $target, the SSH destination.
#
#   remote <command…>              run a short command; reconnect if the line drops
#   remote_in <file> <command…>    the same, with the file as the command's input
#   on_vm <name> <script file>     run a long step on the VM by itself and stream
#                                  its log until it ends; returns its exit status
#
# ssh exits 255 when the connection itself fails; any other code is the
# command's own, and only 255 is retried. Input comes from a file, never a
# pipe, so a retry can send it again. Every step must be safe to repeat.

ssh_opts=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=30)
# Where on_vm keeps each step's script, log and exit status on the VM.
ON_VM_LOGS=${ON_VM_LOGS:-/var/log/autodeploy-ship}
# Seconds between checks on a running step, and the first pause after a drop.
ON_VM_POLL=${ON_VM_POLL:-3}
RETRY_PAUSE=${RETRY_PAUSE:-3}

run_remote() { # run_remote <tries> <stdin file, or '' for none> <command…>
  local tries=$1 input=${2:-/dev/null} try=1 rc pause
  shift 2
  while :; do
    if ssh "${ssh_opts[@]}" "$target" "$@" <"$input"; then return 0; else rc=$?; fi
    if [ "$rc" -ne 255 ] || [ "$try" -ge "$tries" ]; then return "$rc"; fi
    echo "  ↻ the connection to the VM dropped; reconnecting (try $((try + 1)) of $tries)" >&2
    pause=$((try * RETRY_PAUSE))
    sleep $((pause > 15 ? 15 : pause))
    try=$((try + 1))
  done
}

remote() { run_remote 4 '' "$@"; }

remote_in() {
  local file=$1
  shift
  run_remote 4 "$file" "$@"
}

# A transient systemd unit runs the script (as root, with HOME=/root as under
# sudo: a unit gets no HOME of its own, and Docker reads its config there),
# writing its output to a log and,
# when it ends, its exit status to a file. Watching is a series of short
# connections, each patient with drops (about 4 minutes of retrying), so a
# dropped line pauses the watching while the work carries on. Starting is
# idempotent: a retry after the unit started, or even finished, starts nothing.
on_vm() {
  local name=$1 script=$2
  local unit="autodeploy-ship-$name-${RUN_ID:-$$}"
  local log="$ON_VM_LOGS/$unit.log" st="$ON_VM_LOGS/$unit.status"
  remote_in "$script" "sudo install -D -m 700 /dev/stdin $ON_VM_LOGS/$unit.sh"
  remote "systemctl is-active --quiet $unit || sudo test -f $st ||
    sudo systemd-run --quiet --collect --setenv=HOME=/root --unit=$unit bash -c 'bash $ON_VM_LOGS/$unit.sh > $log 2>&1; echo \$? > $st'"
  local seen=0 started=$SECONDS out first status size
  while :; do
    # One line "<status or running> <log size>", then the log from where we were.
    if ! out=$(run_remote 20 '' "s=\$(sudo cat $st 2>/dev/null || echo running); n=\$(sudo stat -c %s $log 2>/dev/null || echo 0); echo \"\$s \$n\"; sudo tail -c +$((seen + 1)) $log 2>/dev/null | head -c \$((n - $seen))"); then
      echo "✗ lost the VM while watching '$name'; it may still finish there ($log)" >&2
      return 1
    fi
    first=${out%%$'\n'*}
    status=${first% *}
    size=${first#* }
    [ "$out" = "$first" ] || printf '%s\n' "${out#*$'\n'}"
    seen=$size
    [ "$status" = running ] || return "$status"
    sleep "$ON_VM_POLL"
    if [ $((SECONDS - started)) -ge 3600 ]; then
      echo "✗ '$name' still running after an hour; stopped watching ($log)" >&2
      return 1
    fi
  done
}
