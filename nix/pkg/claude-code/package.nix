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
  versionCheckHook,
  writableTmpDirAsHomeHook,
  bubblewrap,
  procps,
  socat,
}:
let
  version = "2.1.177";

  # Skip the umbrella stub; fetch the per-platform native pkg directly (see header).
  sources = {
    "x86_64-linux" = {
      pkg = "claude-code-linux-x64";
      hash = "sha256-b0QT0ydE5BX7iYYW/92pI6q1A9cuP7T2sDTbenyRbJA=";
    };
    "aarch64-linux" = {
      pkg = "claude-code-linux-arm64";
      hash = "sha256-Zj0Nr6XIGJWPTWRTyTFXB1MSPmQL9NcJDPxSXZ6hzj4=";
    };
    "x86_64-darwin" = {
      pkg = "claude-code-darwin-x64";
      hash = "sha256-4+wvH3QIAHi+VMynPk/80gNT9wMQr9WtgGJDCKG53Sw=";
    };
    "aarch64-darwin" = {
      pkg = "claude-code-darwin-arm64";
      hash = "sha256-TGvGciqGMEO+2FJVxJ8sfTnlJViI7vDeMrikEBIZmDc=";
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

  nativeBuildInputs = [ makeWrapper ];

  dontConfigure = true;
  dontBuild = true;

  # The `claude` binary is a Bun single-file executable: bun runtime + appended embedded
  # script payload. patchelf would shift the file size and break Bun's payload-offset
  # detection (it falls back to acting as plain `bun` instead of running the bundled app).
  # So we install the binary verbatim and invoke it via the dynamic loader at runtime.
  installPhase = ''
    runHook preInstall
    install -Dm755 claude $out/libexec/claude-code/claude
    runHook postInstall
  '';

  # `claude` tries to auto-update by default, this disables that functionality.
  # https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview#environment-variables
  postFixup =
    let
      runtimePath = lib.makeBinPath (
        [ procps ] ++ lib.optionals isLinux [ bubblewrap socat ]
      );
    in
    if isLinux then
      ''
        mkdir -p $out/bin
        makeWrapper ${stdenv.cc.bintools.dynamicLinker} $out/bin/claude \
          --add-flags "--library-path ${lib.makeLibraryPath [ stdenv.cc.libc ]} $out/libexec/claude-code/claude" \
          --set DISABLE_AUTOUPDATER 1 \
          --set-default FORCE_AUTOUPDATE_PLUGINS 1 \
          --set DISABLE_INSTALLATION_CHECKS 1 \
          --unset DEV \
          --prefix PATH : ${runtimePath}
      ''
    else
      ''
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
