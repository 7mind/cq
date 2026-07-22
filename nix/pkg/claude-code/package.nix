# Updating: run ./update.sh (this dir), then verify with
# ./verify-configs --verbose "$HOSTNAME". The script automates the manual
# recipe below — keep the two in sync.
#
# Manual recipe:
#   1. Latest version:
#        curl -s https://registry.npmjs.org/@anthropic-ai/claude-code/latest | jq -r .version
#   2. Bump `version` + the per-platform `hash` fields below. The umbrella
#      `@anthropic-ai/claude-code` package is just a stub that postinstalls the
#      matching `claude-code-<platform>` native pkg, so we hash those directly:
#        v=2.1.154; for pkg in claude-code-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}; do
#          url="https://registry.npmjs.org/@anthropic-ai/${pkg}/-/${pkg}-${v}.tgz"
#          sha=$(nix-prefetch-url --type sha256 --unpack "$url" 2>/dev/null)
#          sri=$(nix hash convert --hash-algo sha256 --to sri "$sha")
#          printf '%-30s %s\n' "$pkg" "$sri"
#        done
#   3. Verify the build:  ./verify-configs --verbose "$HOSTNAME"
{
  lib,
  stdenv,
  stdenvNoCC,
  fetchzip,
  makeWrapper,
  patchelf,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  bubblewrap,
  procps,
  socat,
}:
let
  version = "2.1.217";

  # Skip the umbrella stub; fetch the per-platform native pkg directly (see header).
  sources = {
    "x86_64-linux" = {
      pkg = "claude-code-linux-x64";
      hash = "sha256-01mMm7ZV7mav8kBPXLyQmBWWuZL2Rtf5NXc9WgPEFZA=";
    };
    "aarch64-linux" = {
      pkg = "claude-code-linux-arm64";
      hash = "sha256-2+Fl/nvhxpLFvAfUgFUTQi2bW+YaFPrhKeagGcNLsVM=";
    };
    "x86_64-darwin" = {
      pkg = "claude-code-darwin-x64";
      hash = "sha256-+ToxqXkh0me0Qthx2PgsEU97pFuA3dy/I/6JN99tul0=";
    };
    "aarch64-darwin" = {
      pkg = "claude-code-darwin-arm64";
      hash = "sha256-W1UGW7OvsiD04tqpsY/1F+HCxRGuOy0U13EbL7T2/v4=";
    };
  };

  source =
    sources.${stdenvNoCC.hostPlatform.system}
      or (throw "claude-code: unsupported system ${stdenvNoCC.hostPlatform.system}");

  isLinux = stdenvNoCC.hostPlatform.isLinux;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "claude-code";
  inherit version;

  src = fetchzip {
    url = "https://registry.npmjs.org/@anthropic-ai/${source.pkg}/-/${source.pkg}-${version}.tgz";
    hash = source.hash;
  };

  nativeBuildInputs = [ makeWrapper ] ++ lib.optionals isLinux [ patchelf ];

  dontConfigure = true;
  dontBuild = true;

  # Keep the Bun single-file executable byte-for-byte. Any fixup that rewrites
  # the ELF by *shifting file offsets* (patchelf --shrink-rpath/--set-rpath,
  # strip) breaks Bun's embedded-payload offset detection — the 2.1.195+ build
  # segfaults (SIGSEGV) under such rewriting where 2.1.177 tolerated it. So we
  # disable the automatic patchelf/strip hooks. The lone deliberate exception is
  # `patchelf --set-interpreter` in postFixup below: it edits PT_INTERP in place
  # without moving the payload, so it is safe (verified). NOT --set-rpath.
  dontPatchELF = true;
  dontStrip = true;

  # The `claude` binary is a Bun single-file executable: bun runtime + appended embedded
  # script payload. patchelf would shift the file size and break Bun's payload-offset
  # detection (it falls back to acting as plain `bun` instead of running the bundled app).
  # So we install the binary verbatim and invoke it via the dynamic loader at runtime.
  installPhase = ''
    runHook preInstall
    install -Dm755 claude $out/libexec/claude-code/claude
    runHook postInstall
  '';

  # Wrap `claude` and disable its auto-updater (which would otherwise fetch past
  # the nix pin). https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview#environment-variables
  #
  # execPath correctness (Linux): the inner `claude` is a native Bun binary that
  # needs the nix glibc loader. The obvious wrapper — `exec ld.so --library-path
  # … inner` — makes Node's process.execPath the *dynamic loader*, which claude
  # exports as CLAUDE_CODE_EXECPATH and bakes into the grep/find shims of its
  # shell snapshot; those then run `ld.so -G …` → "error while loading shared
  # libraries: -G", breaking claude's bundled ugrep/bfs multiplex (keyed on
  # argv0/execPath). Fix: patch PT_INTERP on the inner binary (safe in-place
  # edit — see dontPatchELF above) and exec it DIRECTLY, so execPath is the real
  # binary. The nix glibc loader finds sibling libc/librt/… via its own default
  # search path, so no --library-path/--set-rpath is needed. Darwin needs none
  # of this (Mach-O, no loader indirection), so both platforms share one direct
  # wrapper; Linux just patches the interpreter first.
  postFixup =
    let
      runtimePath = lib.makeBinPath (
        [ procps ] ++ lib.optionals isLinux [ bubblewrap socat ]
      );
    in
    ''
      ${lib.optionalString isLinux ''
        patchelf --set-interpreter ${stdenv.cc.bintools.dynamicLinker} \
          $out/libexec/claude-code/claude
      ''}
      mkdir -p $out/bin
      makeWrapper $out/libexec/claude-code/claude $out/bin/claude \
        --set DISABLE_AUTOUPDATER 1 \
        --set-default FORCE_AUTOUPDATE_PLUGINS 1 \
        --set DISABLE_INSTALLATION_CHECKS 1 \
        --unset DEV \
        --prefix PATH : ${runtimePath}
    '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [
    writableTmpDirAsHomeHook
    versionCheckHook
  ];
  versionCheckKeepEnvironment = [ "HOME" ];

  meta = {
    description = "Agentic coding tool that lives in your terminal, understands your codebase, and helps you code faster";
    homepage = "https://github.com/anthropics/claude-code";
    downloadPage = "https://www.npmjs.com/package/@anthropic-ai/claude-code";
    license = lib.licenses.unfree;
    mainProgram = "claude";
    platforms = lib.attrNames sources;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
})
