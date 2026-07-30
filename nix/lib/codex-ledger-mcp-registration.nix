{ lib }:
registration:
lib.recursiveUpdate registration {
  env.CQ_HARNESS = "codex";
}
