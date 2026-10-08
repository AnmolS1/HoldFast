#!/usr/bin/env bash
# Creates a parallel checkout with its own port and its own database.
#
#   scripts/dev-worktree.sh <task>                  create (or re-describe) .claude/worktrees/<task>
#   scripts/dev-worktree.sh --remove <task> [--force]
#
# Creating: a git worktree on a new branch <task> cut from `dev`, node_modules symlinked to the
# main checkout's, ONE free port from 5180–5199, a .dev.vars written for that port (secrets carried
# over from the main checkout's .dev.vars, never from .env), and a fresh local database
# holdfast_<task>. Run it again for an existing worktree and it only prints the exports.
#
# stdout carries nothing but the `export` lines, so this works:
#   eval "$(scripts/dev-worktree.sh t05)" && cd .claude/worktrees/t05
# All values printed are local (port, database name, localhost URLs). No secret is printed.
set -euo pipefail

export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false

PORT_FIRST=5180
PORT_LAST=5199

say() { echo "dev-worktree: $*" >&2; }
die() {
  say "$*"
  exit 1
}
usage() {
  echo "usage: scripts/dev-worktree.sh <task> | --remove <task> [--force]" >&2
  exit 2
}

remove=0
force=0
task=""
for arg in "$@"; do
  case "$arg" in
    --remove) remove=1 ;;
    --force) force=1 ;;
    -*) usage ;;
    *) [ -z "$task" ] || usage; task="$arg" ;;
  esac
done
[ -n "$task" ] || usage
[[ "$task" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] ||
  die "task must be lowercase letters, digits and dashes (it names a branch, a directory and a database); got '$task'"

# The main checkout, even when this is run from inside a worktree.
common="$(git rev-parse --path-format=absolute --git-common-dir)"
main_root="$(dirname "$common")"
tree="$main_root/.claude/worktrees/$task"
db="holdfast_${task//-/_}"
db_url_base="postgres://postgres:postgres@localhost:5432"

# Port named by a checkout's .dev.vars (only the APP_ORIGIN line is read).
port_of() {
  [ -f "$1/.dev.vars" ] || return 0
  sed -n 's/^APP_ORIGIN=.*:\([0-9][0-9]*\)$/\1/p' "$1/.dev.vars" | head -n 1
}

if [ "$remove" = 1 ]; then
  if [ -d "$tree" ]; then
    # The symlink is untracked (the ignore rule matches directories only) and would block removal.
    [ -L "$tree/node_modules" ] && rm "$tree/node_modules"
    if [ "$force" = 1 ]; then
      git -C "$main_root" worktree remove --force "$tree"
    else
      git -C "$main_root" worktree remove "$tree" ||
        die "worktree has uncommitted work; commit it, or re-run with --force to discard it"
    fi
    say "removed worktree .claude/worktrees/$task"
  else
    git -C "$main_root" worktree prune
    say "no worktree at .claude/worktrees/$task"
  fi
  if command -v psql >/dev/null 2>&1 && psql "$db_url_base/postgres" -Atqc 'select 1' >/dev/null 2>&1; then
    psql "$db_url_base/postgres" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"
    say "dropped database $db"
  else
    say "local Postgres is not reachable; database $db was not dropped"
  fi
  if git -C "$main_root" show-ref --verify --quiet "refs/heads/$task"; then
    # -d refuses a branch with commits that are not merged: that work is kept.
    if git -C "$main_root" branch -d "$task" >/dev/null 2>&1; then
      say "deleted branch $task (it had nothing unmerged)"
    else
      say "kept branch $task: it has commits that are not merged into the current branch"
    fi
  fi
  exit 0
fi

if [ -d "$tree" ]; then
  port="$(port_of "$tree")"
  [ -n "$port" ] || die "worktree exists but its .dev.vars names no port; run: (cd $tree && scripts/dev-env.sh <port>)"
  say "worktree .claude/worktrees/$task already exists (port $port, database $db); nothing was changed"
else
  git -C "$main_root" show-ref --verify --quiet refs/heads/dev || die "there is no local branch 'dev' to cut the worktree from"

  # A port is taken when something listens on it OR when another worktree's .dev.vars names it
  # (an idle worktree holds its port without listening).
  taken=" "
  for other in "$main_root"/.claude/worktrees/*/; do
    [ -d "$other" ] || continue
    p="$(port_of "${other%/}")"
    [ -n "$p" ] && taken="$taken$p "
  done
  port=""
  for candidate in $(seq "$PORT_FIRST" "$PORT_LAST"); do
    case "$taken" in *" $candidate "*) continue ;; esac
    if lsof -nP -iTCP:"$candidate" -sTCP:LISTEN -t >/dev/null 2>&1; then continue; fi
    port="$candidate"
    break
  done
  [ -n "$port" ] || die "no free port in $PORT_FIRST-$PORT_LAST; remove a finished worktree (scripts/dev-worktree.sh --remove <task>)"

  mkdir -p "$main_root/.claude/worktrees"
  if git -C "$main_root" show-ref --verify --quiet "refs/heads/$task"; then
    say "branch $task already exists; checking it out"
    git -C "$main_root" worktree add "$tree" "$task" >&2
  else
    git -C "$main_root" worktree add "$tree" -b "$task" dev >&2
  fi
  ln -sfn ../../../node_modules "$tree/node_modules"

  # The worktree's own copy writes the worktree's .dev.vars. Secrets come from the main checkout's
  # .dev.vars when it exists; the repo-root .env is never read or copied.
  if [ -f "$main_root/.dev.vars" ]; then
    "$tree/scripts/dev-env.sh" "$port" "$main_root/.dev.vars" >&2
  else
    "$tree/scripts/dev-env.sh" "$port" >&2
  fi

  # Prefer the worktree's own db-reset.sh: it applies that branch's migrations.
  reset="$tree/scripts/db-reset.sh"
  [ -x "$reset" ] || reset="$main_root/scripts/db-reset.sh"
  HOLDFAST_DB="$db" "$reset" >&2

  say "created .claude/worktrees/$task on branch $task (port $port, database $db)"
fi

say "run these in the shell that works in the worktree (or eval this script's output):"
cat <<EOF
export HOLDFAST_PORT=$port
export HOLDFAST_DB=$db
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=$db_url_base/$db
export DATABASE_URL_DIRECT=$db_url_base/$db
EOF
