# T865(a): the ANCHORED predicate behind the packaged Codex wrapper's active
# configuration selector — `wrapProgram --set CQ_HARNESS codex` (T863).
#
# `symlinkJoin` folds `postBuild` into the resulting derivation's
# `buildCommand`, so that string is the eval-time handle on what makeWrapper
# will bake into `$out/bin/codex`. Matching it with `lib.hasInfix "CQ_HARNESS
# codex"` is NOT enough: the infix also holds for `--set CQ_HARNESS codex-foo`
# and for a mere mention of the words in a comment or an `echo`. This predicate
# instead tokenises each line and requires an EXACT `--set CQ_HARNESS codex`
# argument triple, so a CHANGED value fails as loudly as an OMITTED one — the
# T865 acceptance ("omits or changes"), at eval time rather than only in the
# built artifact.
#
# `selfTest` mutation-checks the predicate itself against synthetic wrapper
# scripts: a guard that has never been observed rejecting anything is not known
# to work.
{ lib }:
let
  # The whitespace-separated tokens of `line`, dropping the shell line
  # continuation so a trailing `\` never hides behind the value.
  tokensOf =
    line:
    builtins.filter (token: token != "" && token != "\\") (
      lib.splitString " " (lib.replaceStrings [ "\t" ] [ " " ] line)
    );

  # Does `buildCommand` carry an exact `--set <name> <value>` argument triple
  # on a line of its own (which is how wrapProgram invocations are written)?
  setsEnv =
    name: value: buildCommand:
    builtins.any (line: tokensOf line == [ "--set" name value ]) (
      lib.splitString "\n" buildCommand
    );

  # A minimal stand-in for the real wrapper's buildCommand, parameterised by
  # the CQ_HARNESS line under test.
  sample = harnessLine: ''
    wrapProgram $out/bin/codex \
      --set CQ_PROMPT_SURFACE codex \
    ${harnessLine}  --set CQ_PROMPT_ROOT /nix/store/0000-codex-prompt-root
  '';
in
rec {
  # True iff `buildCommand` exports exactly CQ_HARNESS=codex.
  exportsCodexHarness = setsEnv "CQ_HARNESS" "codex";

  # Positive control plus the mutations the weaker infix match let through.
  selfTest =
    assert exportsCodexHarness (sample "  --set CQ_HARNESS codex \\\n");
    assert !(exportsCodexHarness (sample ""));
    assert !(exportsCodexHarness (sample "  --set CQ_HARNESS codex-broken \\\n"));
    assert !(exportsCodexHarness (sample "  --set CQ_HARNESS claude \\\n"));
    assert !(exportsCodexHarness (sample "  --set CQ_HARNESS_EXTRA codex \\\n"));
    assert !(exportsCodexHarness (sample "  echo --set CQ_HARNESS codex \\\n"));
    true;
}
