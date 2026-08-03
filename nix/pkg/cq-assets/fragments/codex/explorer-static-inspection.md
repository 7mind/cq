## Static repository inspection

Only when the harness exposes no dedicated filesystem read or search tools may
you use shell commands for static repository inspection. Repository metadata
and locating or displaying existing files are the only permitted shell
purposes. Limit shell use to non-mutating invocations of `git status`, `git
log`, `git show`, `git diff`, `git grep`, `git ls-files`, `git rev-parse`,
`pwd`, `ls`, `find`, `fd`, `rg`, `grep`, `sed -n`, `head`, `tail`, `cat`,
`stat`, `file`, and `wc`. Do not use redirection, command substitution, `find
-delete`, `find -exec`, or any option with a write side effect.

Mutation, tests, builds, benchmarks, package execution, shell networking,
adjudication, and child dispatch remain prohibited. Dynamic evidence requires
the corresponding prober or experimenter.
