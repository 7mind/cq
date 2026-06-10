# Orphan-ledger ref (`cq-ledger`) — manual-recovery runbook

**Scope.** This runbook applies ONLY when the ledger `[ledger]` backend is
`git-object` (the opt-in experimental backend, T349/Q189). On the default `fs`
backend the ledger is plain files committed under `docs/` and none of this
applies.

Under the git-object backend the ledger lives on an **orphan git branch**,
`cq-ledger` (`[ledger] branch`, default `cq-ledger`), stored as git objects
rather than working-tree files. The `/cq:*` advance commands auto-FETCH that ref
once at run START and auto-PUSH it once at run END against the configured remote
(`[ledger] remote`, default `origin`):

```
# run START (once):
git fetch origin refs/heads/cq-ledger:refs/heads/cq-ledger
# run END (once):
git push origin cq-ledger        # PLAIN, NON-FORCED — never --force
```

The push is deliberately **non-forced**: divergence must FAIL LOUDLY rather than
silently clobber another checkout's pushed ledger updates. (Local lost-updates
within a single checkout are already guarded by the backend's CAS `update-ref`;
the non-forced push is the cross-checkout guard.) Because the push never forces,
you will occasionally hit a rejected (non-fast-forward) push and must reconcile
by hand. The three scenarios below cover the recoveries.

---

## 1. A REJECTED non-fast-forward push (the common case)

**Symptom.** The run-END `git push origin cq-ledger` is rejected:

```
 ! [rejected]        cq-ledger -> cq-ledger (non-fast-forward)
error: failed to push some refs to '<remote>'
hint: Updates were rejected because the tip of your current branch is behind
```

This means the remote `cq-ledger` advanced (another checkout / agent pushed)
after this run's START fetch, so your local tip is behind and a fast-forward is
impossible. **Do NOT `--force`** — forcing would discard the other checkout's
ledger updates. Reconcile instead:

1. **Fetch the current remote tip** of the orphan ref into a local tracking ref
   you can inspect WITHOUT moving your own `cq-ledger`:
   ```
   git fetch origin refs/heads/cq-ledger:refs/remotes/origin/cq-ledger
   ```
2. **Inspect both histories** to see what diverged:
   ```
   git log --oneline --graph cq-ledger origin/cq-ledger
   git log --oneline cq-ledger ^origin/cq-ledger   # commits only you have
   git log --oneline origin/cq-ledger ^cq-ledger   # commits only the remote has
   ```
3. **Reconcile.** The ledger objects are content-addressed, so the safe
   reconciliation is to **re-apply your local-only ledger changes on top of the
   remote tip** rather than to merge blindly:
   - The cleanest path is to let the backend re-derive: move your local ref to
     the remote tip (`git update-ref refs/heads/cq-ledger origin/cq-ledger`),
     re-run the `/cq:*` command so the backend re-applies your in-flight ledger
     mutations through its CAS `update-ref` against the now-current base, OR
   - if you must reconcile by hand, materialize the remote tip in a linked
     worktree (see §3), replay your local-only commits/objects there, and verify
     the ledger validates (`bun test` in `nix/pkg/cq-ledgers/`).
4. **Retry the PLAIN push** (still no `--force`):
   ```
   git push origin cq-ledger
   ```
   If it is rejected again, someone pushed once more in the interim — repeat from
   step 1. The loop terminates because each iteration fast-forwards your base to
   a strictly newer remote tip.

**Never** resolve this with `git push --force` / `--force-with-lease` to the
shared `cq-ledger`: the non-forced contract is the whole point of failing loudly.

---

## 2. Single-branch / shallow clones MUST fetch the ref EXPLICITLY

A normal `git clone` of a single branch (`--single-branch`) or a shallow clone
(`--depth=N`) does NOT include the orphan `cq-ledger` ref in its fetch refspec —
that ref is outside the cloned branch's history and is unreachable from the
default-branch tip. Such a clone has **no local `cq-ledger`** and the git-object
backend cannot read the ledger until you fetch it explicitly:

```
# materialize the orphan ref into a local branch:
git fetch origin refs/heads/cq-ledger:refs/heads/cq-ledger

# a shallow clone additionally needs history depth for the ledger objects —
# unshallow (or deepen) so the ledger commits/objects are present:
git fetch --unshallow origin refs/heads/cq-ledger:refs/heads/cq-ledger
#   or, to deepen by a bounded amount instead of fully unshallowing:
git fetch --depth=1000 origin refs/heads/cq-ledger:refs/heads/cq-ledger
```

The `/cq:*` run-START step performs exactly the first fetch automatically, but on
a fresh single-branch/shallow clone you may need the explicit `--unshallow` /
`--depth` form ONCE so the ledger objects (not just the ref tip) are present
locally. After that, the once-per-run START fetch keeps the ref current.

---

## 3. Linked-worktree FALLBACK — materialize the ref without touching the main checkout

When you need to inspect, reconcile, or operate on the `cq-ledger` ref WITHOUT
disturbing the main checkout's working tree, HEAD, or index, use a **linked git
worktree**. This checks the orphan ref out into a separate directory; the main
checkout is left entirely untouched:

```
# create a linked worktree on the orphan ref in a sibling directory:
git worktree add ../cq-ledger-wt cq-ledger

# ...inspect / reconcile inside ../cq-ledger-wt (git log, diff, replay, validate)...
cd ../cq-ledger-wt
git log --oneline cq-ledger

# when done, remove the linked worktree and prune the administrative entry:
git worktree remove ../cq-ledger-wt
git worktree prune
```

This is the documented fallback for any operation that would otherwise require
checking out `cq-ledger` in place (which would clobber the main working tree). It
is also the recommended place to perform the §1 hand-reconciliation: replay your
local-only ledger changes onto the remote tip inside the linked worktree, verify
the ledger validates, then push the reconciled ref with a PLAIN (non-forced)
push.

> Worktree confinement: operate only inside the linked worktree you created; do
> not run mutating git against the main checkout or any sibling worktree while
> reconciling.
