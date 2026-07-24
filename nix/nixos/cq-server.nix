# NixOS module: the `cq serve` multi-tenant hub backed by a native, tuned
# PostgreSQL — no containers.
#
# `cq serve` (nix/pkg/cq-ledgers/packages/ledger-web/src/hubServe.ts) is the
# pure-CLI hub that hosts EVERY registered project out of ONE shared Postgres
# database. It takes `--host`/`--port`/`--token` on the CLI and resolves its
# DSN from `--pg-url` else `$CQ_LEDGER_PG_URL` else `$DATABASE_URL` — it reads
# neither `cq.toml` nor the `PG*` libpq vars.
#
# TCP-only, by design: `cq`'s Postgres pool is `new SQL(dsn)` (Bun's builtin
# `Bun.sql`, see store/postgres/connection.ts `openPgPool`). Bun.sql reaches a
# server ONLY over TCP from a DSN string — a `postgres:///db?host=/socket` DSN
# is parsed with `host` as a server GUC, not a unix-socket path, and fails.
# So this module runs PostgreSQL on TCP loopback and points `cq serve` at it
# with `postgres://<db>@127.0.0.1:<port>/<db>`.
#
# Curried over `self` so `services.cq-server.package` can default to this
# flake's `cq` build for the host's system.
{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.cq-server;

  # Mirror cq serve's own loopback test (hubServe.ts `isLoopbackHost`): a
  # non-loopback bind REQUIRES a token, enforced by cq at startup; we assert it
  # at eval time so a misconfiguration is caught by `nixos-rebuild`, not at boot.
  isLoopbackHost = host:
    host == "localhost" || host == "::1"
    || (builtins.match "127\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}" host != null);

  db = cfg.database;

  # pgtune-style defaults for a small, dedicated OLTP database, scaled off a
  # declared memory/connection budget. Every value is `mkDefault` so an
  # operator can override any single knob via `services.postgresql.settings`.
  tune = cfg.postgres.tune;
  clampHi = hi: v: if v > hi then hi else v;
  clampLo = lo: v: if v < lo then lo else v;
  tunedSettings = {
    max_connections = tune.maxConnections;
    shared_buffers = "${toString (tune.totalMemoryMB / 4)}MB";
    effective_cache_size = "${toString (tune.totalMemoryMB * 3 / 4)}MB";
    maintenance_work_mem = "${toString (clampHi 2048 (tune.totalMemoryMB / 16))}MB";
    work_mem = "${toString (clampLo 4 (tune.totalMemoryMB / (tune.maxConnections * 4)))}MB";
    wal_buffers = "16MB";
    min_wal_size = "1GB";
    max_wal_size = "4GB";
    checkpoint_completion_target = "0.9";
    default_statistics_target = 100;
    random_page_cost = if tune.ssd then "1.1" else "4.0";
    effective_io_concurrency = if tune.ssd then 200 else 2;
    synchronous_commit = "on";
  };

  # The connection DSN cq will use for the LOCAL, managed Postgres: TCP
  # loopback, trust auth (loopback-only, single-host), no password. When
  # `createLocally = false` the operator supplies the DSN via `database.urlFile`
  # instead (which may carry credentials for a remote server).
  localDsn = "postgres://${db.name}@127.0.0.1:${toString db.port}/${db.name}";

  # ExecStart wrapper: assembles CQ_LEDGER_PG_URL (from the local trust DSN or a
  # runtime-read `urlFile`), reads an optional token from a systemd credential
  # into CQ_SERVE_TOKEN (env, not a `ps`-visible --token flag), points
  # LEDGER_WEB_OUTDIR at the writable StateDirectory (the hub rebuilds the web
  # bundle on start and the package's own dist/ is read-only in the store),
  # then execs cq serve.
  startScript = pkgs.writeShellScript "cq-server-start" ''
    set -eu

    ${if db.urlFile != null then ''
      CQ_LEDGER_PG_URL="$(cat ${lib.escapeShellArg (toString db.urlFile)})"
    '' else ''
      CQ_LEDGER_PG_URL=${lib.escapeShellArg localDsn}
    ''}
    export CQ_LEDGER_PG_URL

    ${lib.optionalString (cfg.tokenFile != null) ''
      CQ_SERVE_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/token")"
      export CQ_SERVE_TOKEN
    ''}

    export LEDGER_WEB_OUTDIR="$STATE_DIRECTORY/web"
    mkdir -p "$LEDGER_WEB_OUTDIR"

    set -- serve --host ${lib.escapeShellArg cfg.host} --port ${toString cfg.port}
    ${lib.concatMapStringsSep "\n" (a: "set -- \"$@\" ${lib.escapeShellArg a}") cfg.extraArgs}

    exec ${cfg.package}/bin/cq "$@"
  '';
in
{
  options.services.cq-server = {
    enable = lib.mkEnableOption "the cq serve multi-tenant hub over a native, tuned PostgreSQL";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.cq;
      defaultText = lib.literalExpression "self.packages.\${system}.cq";
      description = "The cq package providing `bin/cq` (with the `serve` mode).";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      example = "0.0.0.0";
      description = ''
        Bind address for `cq serve`. A non-loopback host (anything outside
        127.0.0.0/8 / ::1 / localhost) makes {option}`services.cq-server.tokenFile`
        mandatory — cq refuses such a bind without a token (Q273).
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 5190;
      description = "TCP port for `cq serve` (distinct from `cq web`'s 5180).";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open {option}`services.cq-server.port` in the firewall.";
    };

    tokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/cq-server-token";
      description = ''
        Path to a file containing the API bearer token. Injected into
        `cq serve` via the `CQ_SERVE_TOKEN` environment variable — not a
        `ps`-visible `--token` flag. REQUIRED when
        {option}`services.cq-server.host` is not a loopback address. Loaded via
        a systemd credential (not placed in the Nix store).
      '';
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "cq-server";
      description = "System user the hub runs as.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "cq-server";
      description = "System group the hub runs as.";
    };

    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Extra arguments appended to the `cq serve` invocation.";
    };

    database = {
      createLocally = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Provision and tune a local PostgreSQL server (via
          {option}`services.postgresql`), create the role+database, and connect
          over TCP loopback with trust auth. Set to `false` to point the hub at
          an external server via {option}`services.cq-server.database.urlFile`.
        '';
      };

      name = lib.mkOption {
        type = lib.types.str;
        default = "cq";
        description = ''
          Name used for BOTH the PostgreSQL role and the database (they must
          match for `ensureDBOwnership`). Also the connecting user in the local
          DSN.
        '';
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 5432;
        description = "TCP port of the local PostgreSQL server (loopback).";
      };

      urlFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        example = "/run/secrets/cq-ledger-pg-url";
        description = ''
          Path to a file containing a full Postgres DSN (`postgres://user:pass@host:port/db`),
          used verbatim as `CQ_LEDGER_PG_URL`. Overrides the generated local
          DSN; REQUIRED when {option}`services.cq-server.database.createLocally`
          is `false`. Read at service start (not placed in the Nix store).
        '';
      };
    };

    postgres.tune = {
      totalMemoryMB = lib.mkOption {
        type = lib.types.ints.positive;
        default = 2048;
        description = ''
          Memory budget (MB) PostgreSQL may plan around. Drives shared_buffers
          (25%), effective_cache_size (75%), maintenance_work_mem and work_mem.
          Every derived value is a default overridable via
          {option}`services.postgresql.settings`.
        '';
      };

      maxConnections = lib.mkOption {
        type = lib.types.ints.positive;
        default = 100;
        description = "PostgreSQL `max_connections` (also scales work_mem).";
      };

      ssd = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Assume SSD/NVMe storage: sets random_page_cost = 1.1 and
          effective_io_concurrency = 200 (vs 4.0 / 2 for spinning disks).
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = (!isLoopbackHost cfg.host) -> (cfg.tokenFile != null);
        message =
          "services.cq-server: host '${cfg.host}' is not loopback; cq serve refuses a "
          + "non-loopback bind without a token. Set services.cq-server.tokenFile.";
      }
      {
        assertion = (!cfg.database.createLocally) -> (cfg.database.urlFile != null);
        message =
          "services.cq-server: database.createLocally = false requires "
          + "database.urlFile (the DSN of the external Postgres server).";
      }
    ];

    services.postgresql = lib.mkIf cfg.database.createLocally {
      enable = true;
      enableTCPIP = true;
      # cq's Bun.sql pool needs TCP; keep it loopback-only.
      settings = lib.mkMerge [
        (lib.mapAttrs (_: lib.mkDefault) tunedSettings)
        { listen_addresses = lib.mkForce "127.0.0.1"; port = lib.mkDefault cfg.database.port; }
      ];
      # Trust auth for the cq role over TCP loopback (single-host, loopback-only
      # DB). mkBefore so these host rules match ahead of the module defaults.
      authentication = lib.mkBefore ''
        host ${db.name} ${db.name} 127.0.0.1/32 trust
        host ${db.name} ${db.name} ::1/128      trust
      '';
      ensureDatabases = [ db.name ];
      ensureUsers = [
        {
          name = db.name;
          ensureDBOwnership = true;
        }
      ];
    };

    users.users = lib.mkIf (cfg.user == "cq-server") {
      cq-server = {
        isSystemUser = true;
        group = cfg.group;
        description = "cq serve hub";
      };
    };
    users.groups = lib.mkIf (cfg.group == "cq-server") { cq-server = { }; };

    systemd.services.cq-server = {
      description = "cq serve multi-tenant ledger hub";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ] ++ lib.optional cfg.database.createLocally "postgresql.service";
      requires = lib.optional cfg.database.createLocally "postgresql.service";

      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        ExecStart = startScript;
        Restart = "on-failure";
        RestartSec = 2;
        StateDirectory = "cq-server";
        StateDirectoryMode = "0700";
        LoadCredential = lib.optional (cfg.tokenFile != null) "token:${toString cfg.tokenFile}";

        # Hardening — the hub only needs loopback (or outbound) TCP + its state dir.
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        RestrictNamespaces = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = false; # Bun JIT needs W^X-relaxed pages.
        SystemCallArchitectures = "native";
      };
    };

    networking.firewall = lib.mkIf cfg.openFirewall {
      allowedTCPPorts = [ cfg.port ];
    };
  };
}
