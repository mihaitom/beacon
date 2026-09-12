# Shared by pre-commit and pre-push. Two things in here are not about
# checking anything, but about what a failure *looks* like in VS Code —
# which is where commits and pushes are made, and where the message worth
# reading kept getting lost.
#
# 1. VS Code's git extension runs hooks with LC_ALL=en_US.UTF-8, a locale
#    plenty of Linux installs never generate (this machine has C, C.utf8,
#    de_DE.utf8, POSIX). Every command then writes
#      sh: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8)
#    to stderr. Tested rather than guessed at: `locale` stays quiet when the
#    current setting is usable and complains when it is not, so that is what
#    decides. A machine without `locale` at all is left alone.
#
# 2. The "commit failed" dialog shows the *first line the hook printed*,
#    whichever stream it came on, and nothing else. It read "sh: warning:
#    setlocale…", then "Backing up original state…" (lint-staged's own
#    progress), then "→ lint-staged…" (ours) — each time the first line out
#    of the gate rather than the one that mattered. So when git is capturing
#    the output, a hook prints nothing at all until something fails, and
#    what it prints first is the verdict. The full output follows it, one
#    "Show Command Output" away.
#
#    In a terminal, where somebody is watching a long hook run, the progress
#    lines are worth having — hence `[ -t 1 ]`: a human at a terminal gets
#    them, a captured run does not.
if [ -n "${LC_ALL:-}" ] && [ -n "$(locale 2>&1 >/dev/null)" ]; then
  export LC_ALL=C.UTF-8
fi

# run "what is being checked" "the command" ["how to fix it"]
#
# The output is captured rather than streamed, so the verdict can quote the
# first thing that actually went wrong. The cost is that a long step (either
# test suite) prints nothing until it is done — the "→ …" line above it is
# what says which one is running.
run() {
  if [ -t 1 ]; then printf '→ %s…\n' "$1"; fi
  if output=$(sh -c "$2" 2>&1); then
    if [ -t 1 ]; then printf '%s\n' "$output"; fi
    return 0
  fi

  # The line that names the actual problem, not the first line that happens
  # to contain the word "error" — lint-staged prints "✖ eslint --fix" as its
  # own task marker well before eslint says what is wrong. Each pattern is a
  # tool's own way of pointing at a place: eslint puts the path on its own
  # line and the position on the next (both are picked up and joined),
  # vue-tsc writes "file.ts(12,3): error TS…", pytest "FAILED tests/x.py::y"
  # or an "E   " line, ruff an "--> file:line:col", prettier "[warn] file".
  detail=$(printf '%s\n' "$output" | awk '
    /^[~/]?[A-Za-z0-9._-]+\// { file = $0 }
    /^[A-Z][0-9][0-9][0-9] / { rule = $0 }
    /^[[:space:]]*[0-9]+:[0-9]+[[:space:]]+(error|warning)/ {
      n = split(file, parts, "/")
      printf "%s %s\n", parts[n], $0
      found = 1
      exit
    }
    /--> / {
      printf "%s%s\n", (rule == "" ? "" : rule " "), $0
      found = 1
      exit
    }
    /\([0-9]+,[0-9]+\): error/ || /^FAILED / || /^E   / || /^\[warn\] / || /(^|[[:space:]])FAIL[[:space:]]/ {
      print
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' | sed 's/[[:space:]]\{2,\}/ /g; s/^[[:space:]]*//' | cut -c1-200)

  # A tool that phrases things some other way: the first line that reads
  # like a complaint at all, and failing that the last line it printed.
  if [ -z "$detail" ]; then
    detail=$(printf '%s\n' "$output" |
      grep -m1 -iE 'error|failed|✖|✗' |
      sed 's/[[:space:]]\{2,\}/ /g; s/^[[:space:]]*//' |
      cut -c1-200)
  fi
  if [ -z "$detail" ]; then
    detail=$(printf '%s\n' "$output" | grep -v '^[[:space:]]*$' | tail -1)
  fi

  # The verdict first and everything else after it, so the first line of
  # the hook's output is the one worth reading — see the note at the top.
  # Both go to stderr: which stream a caller reads first is its own
  # business, and this way the order is not a matter of luck.
  {
    if [ -n "$3" ]; then
      printf '✗ %s: %s — fix: %s\n' "$1" "$detail" "$3"
    else
      printf '✗ %s: %s\n' "$1" "$detail"
    fi
    printf '%s\n' "$output"
  } >&2
  exit 1
}
