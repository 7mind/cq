{ lib, codexPromptRoot }:
registration:
lib.recursiveUpdate registration {
  args = (registration.args or [ ]) ++ [
    "--prompt-surface"
    "codex"
    "--prompt-root"
    (toString codexPromptRoot)
  ];
  env = {
    CQ_HARNESS = "codex";
    CQ_PROMPT_ROOT = toString codexPromptRoot;
    CQ_PROMPT_SURFACE = "codex";
  };
}
