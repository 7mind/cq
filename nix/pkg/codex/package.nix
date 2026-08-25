# Updating: run ./update.sh (this dir). The script bumps `version` and refreshes
# the per-platform `hash` and `codeModeHostHash` entries below for the latest
# GitHub-released static binaries. Using the release artefacts (vs nixpkgs'
# rust build) skips a multi-minute Cargo vendor build and tracks alpha tags
# closely. Keep this in sync with the manual recipe below.
#
# Manual recipe:
#   1. Latest version:
#        curl -fsSL https://api.github.com/repos/openai/codex/releases/latest \
#          | jq -r '.tag_name | sub("^rust-v"; "")'
#   2. Bump `version` + the eight hash fields below. The release assets are the
#      CLI and code-mode-host archives for each platform:
#        v=$(curl -fsSL https://api.github.com/repos/openai/codex/releases/latest \
#          | jq -r '.tag_name | sub("^rust-v"; "")')
#        for asset in \
#          codex-x86_64-unknown-linux-musl.tar.gz \
#          codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz \
#          codex-aarch64-unknown-linux-musl.tar.gz \
#          codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz \
#          codex-x86_64-apple-darwin.tar.gz \
#          codex-code-mode-host-x86_64-apple-darwin.tar.gz \
#          codex-aarch64-apple-darwin.tar.gz \
#          codex-code-mode-host-aarch64-apple-darwin.tar.gz; do
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
  version = "0.149.1";
  binaryAssets = {
    aarch64-darwin = {
      asset = "codex-aarch64-apple-darwin.tar.gz";
      hash = "sha256-7WD0dcbdpgRMLAD9fzMnPMPz+YkAzNEgS/3y/pNfNAU=";
      codeModeHostAsset = "codex-code-mode-host-aarch64-apple-darwin.tar.gz";
      codeModeHostHash = "sha256-quHAyUWXAKLol62t1kc1EUCueTOtc72NOvZQXGmk8/0=";
    };
    aarch64-linux = {
      asset = "codex-aarch64-unknown-linux-musl.tar.gz";
      hash = "sha256-FN9oAuOalW3plOhEuQ1R2CVLzIBXtuZvDz47j34tpbA=";
      codeModeHostAsset = "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz";
      codeModeHostHash = "sha256-li4CnfdytTy5d6AgTsQoTQxpMgeiWkkRBugpSq6N+gQ=";
    };
    x86_64-darwin = {
      asset = "codex-x86_64-apple-darwin.tar.gz";
      hash = "sha256-hf56g363Od1eHMWanJW3toIEjlqs3CYVBbrnaPsSiO8=";
      codeModeHostAsset = "codex-code-mode-host-x86_64-apple-darwin.tar.gz";
      codeModeHostHash = "sha256-OiS8NC6g5gnnB/YhGYfUmcM8CaT3WJGpTdRr7498W74=";
    };
    x86_64-linux = {
      asset = "codex-x86_64-unknown-linux-musl.tar.gz";
      hash = "sha256-4k+3hMfXEUDWevtiD1bpE3SWz39snhkhf6Nmbc8wYng=";
      codeModeHostAsset = "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz";
      codeModeHostHash = "sha256-YvosPl1LxYcgvXKy7iq4Y24aqp2CNt2uQaHM5ii1mus=";
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

    # Main CLI + sibling code-mode host (0.147+ spawns `codex-code-mode-host`
    # from PATH next to `codex`; omitting it breaks every tool call with
    # "failed to spawn .../codex-code-mode-host: No such file or directory").
    srcs = [
      (fetchurl {
        url = "https://github.com/openai/codex/releases/download/rust-v${version}/${binaryAsset.asset}";
        hash = binaryAsset.hash;
      })
      (fetchurl {
        url = "https://github.com/openai/codex/releases/download/rust-v${version}/${binaryAsset.codeModeHostAsset}";
        hash = binaryAsset.codeModeHostHash;
      })
    ];
    sourceRoot = ".";

    nativeBuildInputs = [
      installShellFiles
      makeBinaryWrapper
    ];

    dontConfigure = true;
    dontBuild = true;

    # fetchurl multi-src lands as $NIX_BUILD_TOP/<hash>-name; unpack both.
    unpackPhase = ''
      runHook preUnpack
      for src in $srcs; do
        tar -xzf "$src"
      done
      runHook postUnpack
    '';

    installPhase = ''
      runHook preInstall
      # Both release tarballs expand to a single platform-suffixed binary.
      # `codex-*` would also match `codex-code-mode-host-*`, so pick explicitly.
      shopt -s nullglob
      main=(codex-aarch64-* codex-x86_64-*)
      host=(codex-code-mode-host-*)
      if [ "''${#main[@]}" -ne 1 ]; then
        echo "expected exactly one main codex binary, found: ''${main[*]:-none}" >&2
        exit 1
      fi
      if [ "''${#host[@]}" -ne 1 ]; then
        echo "expected exactly one codex-code-mode-host binary, found: ''${host[*]:-none}" >&2
        exit 1
      fi
      install -Dm755 "''${main[0]}" "$out/bin/codex"
      install -Dm755 "''${host[0]}" "$out/bin/codex-code-mode-host"
      runHook postInstall
    '';

    postInstall = lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
      installShellCompletion --cmd codex \
        --bash <($out/bin/codex completion bash) \
        --fish <($out/bin/codex completion fish) \
        --zsh <($out/bin/codex completion zsh)
    '';

    postFixup = ''
      # Keep code-mode-host on the same PATH as the wrapped codex so relative
      # sibling discovery and PATH lookup both succeed.
      wrapProgram "$out/bin/codex" --prefix PATH : ${
        lib.makeBinPath ([ ripgrep ] ++ lib.optionals stdenv.hostPlatform.isLinux [ bubblewrap ])
      }:$out/bin
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
