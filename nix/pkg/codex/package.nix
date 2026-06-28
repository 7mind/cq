# Updating: run ./update.sh (this dir). The script bumps `version` and refreshes
# the four per-platform `hash` entries below for the latest GitHub-released
# static binary. Using the release artefact (vs nixpkgs' rust build) skips a
# multi-minute Cargo vendor build and tracks alpha tags closely. Keep this in
# sync with the manual recipe below.
#
# Manual recipe:
#   1. Latest version:
#        curl -fsSL https://api.github.com/repos/openai/codex/releases/latest \
#          | jq -r '.tag_name | sub("^rust-v"; "")'
#   2. Bump `version` + the four `hash` fields below. The release assets are the
#      four `codex-<platform>.tar.gz` archives:
#        v=$(curl -fsSL https://api.github.com/repos/openai/codex/releases/latest \
#          | jq -r '.tag_name | sub("^rust-v"; "")')
#        for asset in \
#          codex-x86_64-unknown-linux-musl.tar.gz \
#          codex-aarch64-unknown-linux-musl.tar.gz \
#          codex-x86_64-apple-darwin.tar.gz \
#          codex-aarch64-apple-darwin.tar.gz; do
#          url="https://github.com/openai/codex/releases/download/rust-v${v}/${asset}"
#          sha=$(nix-prefetch-url --type sha256 "$url" 2>/dev/null)
#          sri=$(nix hash convert --hash-algo sha256 --to sri "$sha")
#          printf '%-45s %s\n' "$asset" "$sri"
#        done
#   3. Verify the build: `nix build .#codex`
#
#
# Vendored into the cq flake alongside the rest of the LLM harness so consumers
# don't need an overlay to pin codex. `codex` (the nixpkgs base) is used only
# for meta/passthru and as the fallback on unsupported systems.
{ lib
, stdenv
, stdenvNoCC
, fetchurl
, installShellFiles
, makeBinaryWrapper
, ripgrep
, bubblewrap
, versionCheckHook
, codex
}:

let
  version = "0.142.3";
  binaryAssets = {
    aarch64-darwin = {
      asset = "codex-aarch64-apple-darwin.tar.gz";
      hash = "sha256-wwMVy0HWbQAPya1mc19CiNn/DH/nSPaPcautcC1y+DI=";
    };
    aarch64-linux = {
      asset = "codex-aarch64-unknown-linux-musl.tar.gz";
      hash = "sha256-1LsYeTzVOQJZPduSxAnyYsBdyA5CNfhl7eI3i6FaHdE=";
    };
    x86_64-darwin = {
      asset = "codex-x86_64-apple-darwin.tar.gz";
      hash = "sha256-s3ZJQyf7sNPJPddS8+c6HCIaRQS7/jRahCC9+PC9P0o=";
    };
    x86_64-linux = {
      asset = "codex-x86_64-unknown-linux-musl.tar.gz";
      hash = "sha256-+WgT9BaStNiuRNCBIWWi/MQpGW6zSB9rwiGv3slqF/g=";
    };
  };
  system = stdenv.hostPlatform.system;
in
if lib.hasAttr system binaryAssets then
  let
    binaryAsset = binaryAssets.${system};
  in
  stdenvNoCC.mkDerivation {
    pname = "codex";
    inherit version;

    src = fetchurl {
      url = "https://github.com/openai/codex/releases/download/rust-v${version}/${binaryAsset.asset}";
      hash = binaryAsset.hash;
    };

    nativeBuildInputs = [
      installShellFiles
      makeBinaryWrapper
    ];

    dontUnpack = true;
    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall
      tar -xzf "$src"
      install -Dm755 codex-* "$out/bin/codex"
      runHook postInstall
    '';

    postInstall = lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
      installShellCompletion --cmd codex \
        --bash <($out/bin/codex completion bash) \
        --fish <($out/bin/codex completion fish) \
        --zsh <($out/bin/codex completion zsh)
    '';

    postFixup = ''
      wrapProgram "$out/bin/codex" --prefix PATH : ${
        lib.makeBinPath ([ ripgrep ] ++ lib.optionals stdenv.hostPlatform.isLinux [ bubblewrap ])
      }
    '';

    doInstallCheck = stdenv.buildPlatform.canExecute stdenv.hostPlatform;
    nativeInstallCheckInputs = [ versionCheckHook ];

    meta = codex.meta // {
      mainProgram = "codex";
    };

    passthru = codex.passthru or { };
  }
else
  codex
