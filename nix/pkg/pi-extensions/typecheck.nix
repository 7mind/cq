{
  pkgs,
  bunNodeModules,
  cqLedgersSource,
  piCodingAgent,
  piExtensionsNodeModules,
  source,
}:
pkgs.runCommand "pi-extensions-typecheck"
  {
    nativeBuildInputs = [
      pkgs.nodejs_22
      pkgs.ripgrep
    ];
  }
  ''
    set -eu

    work="$NIX_BUILD_TOP/pi-extensions"
    cp -r ${source} "$work"
    chmod -R u+w "$work"

    cqWorkspace="$NIX_BUILD_TOP/cq-ledgers"
    cp -r ${cqLedgersSource} "$cqWorkspace"
    chmod -R u+w "$cqWorkspace"
    cp -r ${bunNodeModules}/node_modules "$cqWorkspace/node_modules"
    for package in ledger cq-config; do
      cp -r ${bunNodeModules}/packages/$package/node_modules \
        "$cqWorkspace/packages/$package/node_modules"
    done
    chmod -R u+w \
      "$cqWorkspace/node_modules" \
      "$cqWorkspace/packages/ledger/node_modules" \
      "$cqWorkspace/packages/cq-config/node_modules"
    for package in ledger cq-config; do
      mkdir -p "$cqWorkspace/packages/$package/node_modules/@cq"
      ln -s ../../../process-control \
        "$cqWorkspace/packages/$package/node_modules/@cq/process-control"
    done

    valueImportPattern='^[\t ]*import[\t ]+(?!type(?:[\t ]|\{))(?:(?:[^"\x27\n]+)[\t ]+from[\t ]+)?["\x27]@(earendil-works|cq)/'
    if rg --pcre2 -n "$valueImportPattern" \
      --glob '*.ts' \
      --glob '!*.test.ts' \
      "$work/ledger-status" \
      "$work/auto-driver"; then
      echo "Pi extension production sources contain a forbidden host-package value import" >&2
      exit 1
    fi

    staleTypingPattern='v0\.78\.0|v0\.81\.1|KEEP IN SYNC with those typings|copy-not-import|COPY-NOT-IMPORT|LOCAL STRUCTURAL'
    if rg -n "$staleTypingPattern" \
      "$work/ledger-status/index.ts" \
      "$work/auto-driver/driver.ts" \
      "$work/auto-driver/index.ts" \
      "$work/auto-driver/oracle.ts"; then
      echo "Pi host-API sources contain superseded structural-typing guidance" >&2
      exit 1
    fi

    # Each standalone package gets both type-only dependency links at its own
    # bundler-resolution root: Pi from the Nix package and @cq/ledger from the
    # copied cq workspace. No npm-provided Pi package enters this check.
    for project in auto-driver ledger-status; do
      modules="$work/$project/node_modules"
      cp -r ${piExtensionsNodeModules}/$project/node_modules "$modules"
      chmod -R u+w "$modules"
      test ! -e "$modules/@earendil-works/pi-coding-agent"
      test ! -e "$modules/@cq/ledger"
      mkdir -p "$modules/@earendil-works"
      mkdir -p "$modules/@cq"
      ln -s ${piCodingAgent}/lib/node_modules/pi-monorepo \
        "$modules/@earendil-works/pi-coding-agent"
      ln -s "$cqWorkspace/packages/ledger" "$modules/@cq/ledger"

      echo "typecheck: $project"
      node "$modules/typescript/bin/tsc" \
        --noEmit \
        --project "$work/$project/tsconfig.json"
    done

    touch "$out"
  ''
