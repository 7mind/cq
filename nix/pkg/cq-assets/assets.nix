# Normalized LLM-asset bundle for this repo, consumed by a home-manager
# materializer (e.g. 7mind/nix-config) as `inputs.<this>.llmAssets`.
#
# Pure, eval-time, IFD-FREE: every value is read with builtins.readFile /
# readDir over THIS flake's source tree (no derivation output is read), so a
# consumer can splice the attrset straight into module config without forcing a
# build. The shape is the cross-repo contract — keep it stable:
#
#   { skills   = { <name>      = "<meta+content string>"; };
#     commands = { "<ns>/<name>" = "<file body>"; };   # → /<ns>:<name>
#     agents   = { <name>      = "<file body>"; };      # subagent defs
#     context  = [ "<CLAUDE.md / AGENTS.md fragment>" ];
#     catalog  = [ <ordered validated prompt-role entries> ];
#     catalogJson = "<deterministic JSON projection>";
#     agentCatalogJson = "<dispatched-role JSON projection>";
#     promptSurfaceLayout = [ <per-surface output paths> ]; }
#
# Directory convention under ./llm:
#   commands/<ns>/<name>.md        agents/<name>.md
#   skills/<name>/{meta.yaml,content.md}     context.md (optional)
{ lib }:
let
  # Recursively collect every *.md under `dir`, keyed by its path relative to
  # `dir` with the `.md` stripped (so commands/cq/plan/advance.md → "cq/plan/advance").
  collectMd = dir:
    lib.concatMapAttrs
      (name: type:
        if type == "directory" then
          lib.mapAttrs'
            (k: v: lib.nameValuePair "${name}/${k}" v)
            (collectMd (dir + "/${name}"))
        else if lib.hasSuffix ".md" name then
          { ${lib.removeSuffix ".md" name} = builtins.readFile (dir + "/${name}"); }
        else { })
      (builtins.readDir dir);

  collectMdIn = sub: if builtins.pathExists sub then collectMd sub else { };

  # skills/<name>/{meta.yaml,content.md} → "---\n<meta>---\n\n<content>"
  # (matches the inline-string shape the upstream `programs.<agent>.skills`
  # option expects; never a store path, to stay IFD-free).
  skillNames =
    if builtins.pathExists ./skills then
      builtins.attrNames (lib.filterAttrs (_: t: t == "directory") (builtins.readDir ./skills))
    else [ ];
  mkSkill = name:
    "---\n"
    + builtins.readFile (./skills + "/${name}/meta.yaml")
    + "---\n\n"
    + builtins.readFile (./skills + "/${name}/content.md");

  commands = collectMdIn ./commands;
  agents = collectMdIn ./agents;

  promptSurfaceSchema = import ../../lib/prompt-surfaces.nix { inherit lib; };
  promptSurfaces = promptSurfaceSchema.promptSurfaces;

  fail = path: detail: throw "prompt catalog: ${path}: ${detail}";

  unique =
    values:
    builtins.foldl' (
      result: value:
      if builtins.elem value result then result else result ++ [ value ]
    ) [ ] values;

  authoredFragmentContracts = [
    {
      fragment = "cq-command-invocation";
      supportedSurfaces = promptSurfaces;
      forbiddenVocabulary = {
        claude = [ "$cq-" ];
        codex = [ "/cq:" ];
        pi = [ "$cq-" ];
      };
      intentionalDifference = {
        kind = "invocation-syntax";
        reason = "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.";
        surfaces = promptSurfaces;
      };
    }
    {
      fragment = "subagent-dispatch";
      supportedSurfaces = promptSurfaces;
      forbiddenVocabulary = {
        claude = [ "dispatch_agent(" ];
        codex = [
          "Agent("
          "dispatch_agent("
        ];
        pi = [ "Agent(" ];
      };
      intentionalDifference = {
        kind = "dispatch-protocol";
        reason = "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.";
        surfaces = promptSurfaces;
      };
    }
    {
      fragment = "inline-command-recursion";
      supportedSurfaces = promptSurfaces;
      forbiddenVocabulary = {
        claude = [
          "fetch_prompt("
          "$cq-"
        ];
        codex = [
          "/cq:"
          "fetch_prompt("
        ];
        pi = [ "$cq-" ];
      };
      intentionalDifference = {
        kind = "recursion-protocol";
        reason = "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.";
        surfaces = promptSurfaces;
      };
    }
    {
      fragment = "host-tool-vocabulary";
      supportedSurfaces = promptSurfaces;
      forbiddenVocabulary = {
        claude = [
          "dispatch_agent("
          "$cq-"
        ];
        codex = [
          "allowed-tools:"
          "disallowedTools:"
          "mcp__ledger__"
          "Agent"
        ];
        pi = [
          "Agent"
          "$cq-"
        ];
      };
      intentionalDifference = {
        kind = "tool-vocabulary";
        reason = "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.";
        surfaces = promptSurfaces;
      };
    }
    {
      fragment = "operational-tool-vocabulary";
      supportedSurfaces = promptSurfaces;
      forbiddenVocabulary = {
        claude = [ "dispatch_agent(" ];
        codex = [
          "mcp__ledger__"
          "Agent("
        ];
        pi = [
          "mcp__ledger__"
          "Agent("
        ];
      };
      intentionalDifference = {
        kind = "tool-vocabulary";
        reason = "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.";
        surfaces = promptSurfaces;
      };
    }
  ];

  sourceBlockByFragment = {
    cq-command-invocation = "frontmatter and body CQ command references";
    subagent-dispatch = "subagent dispatch instructions and host transport branch";
    inline-command-recursion = "inline chained-command execution instructions";
    host-tool-vocabulary = "frontmatter host tool and isolation capabilities";
    operational-tool-vocabulary = "body-level mapping from canonical operational tokens to callable host tools";
  };
  sharedSourceBlock = {
    sourceBlock = "all prose outside the classified surface-sensitive blocks";
    classification = "shared-prose";
    targetFragment = null;
  };

  validateFragmentContract =
    index: contract:
    let
      contractPath = "fragmentContracts[${toString index}]";
    in
    if !builtins.isAttrs contract then
      fail contractPath "expected an attribute set"
    else if builtins.attrNames contract != [
      "forbiddenVocabulary"
      "fragment"
      "intentionalDifference"
      "supportedSurfaces"
    ] then
      fail contractPath "unexpected fragment-contract shape"
    else if !builtins.isString contract.fragment || !(builtins.hasAttr contract.fragment sourceBlockByFragment) then
      fail "${contractPath}.fragment" "unknown fragment"
    else if contract.supportedSurfaces != promptSurfaces then
      fail "${contractPath}.supportedSurfaces" "expected every prompt surface exactly once in canonical order"
    else if
      !builtins.isAttrs contract.forbiddenVocabulary
      || builtins.attrNames contract.forbiddenVocabulary != promptSurfaces
      || !(lib.all (
        surface:
        builtins.isList contract.forbiddenVocabulary.${surface}
        && lib.all (
          token: builtins.isString token && token != ""
        ) contract.forbiddenVocabulary.${surface}
      ) promptSurfaces)
    then
      fail "${contractPath}.forbiddenVocabulary" "expected one non-empty-token array per prompt surface"
    else
      contract
      // {
        intentionalDifference = promptSurfaceSchema.validateIntentionalDifference contract.intentionalDifference;
      };

  fragmentContracts = lib.imap0 validateFragmentContract authoredFragmentContracts;
  fragmentContractsById = lib.listToAttrs (
    map (contract: lib.nameValuePair contract.fragment contract) fragmentContracts
  );
  fragmentContractIds = map (contract: contract.fragment) fragmentContracts;

  mkFragmentBinding =
    fragment:
    let
      contract =
        fragmentContractsById.${fragment}
          or (fail "fragmentBindings.fragment" "unknown fragment \"${fragment}\"");
    in
    {
      inherit fragment;
      sourceBlock = sourceBlockByFragment.${fragment};
      inherit (contract)
        supportedSurfaces
        forbiddenVocabulary
        intentionalDifference
        ;
    };

  dispatch = targetRoleId: {
    kind = "dispatch";
    inherit targetRoleId;
  };

  recursion = targetRoleId: {
    kind = "recursion";
    inherit targetRoleId;
  };

  mkRole =
    {
      roleId,
      roleKind,
      canonicalSource,
      fragments,
      dispatchRelations,
    }:
    let
      fragmentBindings = map mkFragmentBinding fragments;
    in
    {
      inherit
        roleId
        roleKind
        canonicalSource
        fragmentBindings
        dispatchRelations
        sharedSourceBlock
        ;
      name =
        if roleKind == "dispatched-subagent" then
          roleId
        else
          "/cq:${lib.replaceStrings [ "/" ] [ ":" ] roleId}";
      surfaces = promptSurfaces;
      sidecar =
        if roleKind == "dispatched-subagent" then
          { schemaRoleId = roleId; }
        else
          null;
      intentionalDifferences = unique (
        map (binding: binding.intentionalDifference) fragmentBindings
      );
    };

  mkAgent =
    roleId: fragments:
    mkRole {
      inherit roleId fragments;
      roleKind = "dispatched-subagent";
      canonicalSource = "agents/${roleId}.md";
      dispatchRelations = [ ];
    };

  mkCommand =
    roleId: fragments: dispatchRelations:
    mkRole {
      inherit roleId fragments dispatchRelations;
      roleKind = "orchestrator-command";
      canonicalSource = "commands/cq/${roleId}.md";
    };

  I = "cq-command-invocation";
  D = "subagent-dispatch";
  R = "inline-command-recursion";
  T = "host-tool-vocabulary";
  O = "operational-tool-vocabulary";

  authoredCatalog = [
    (mkAgent "plan-advance" [ I T ])
    (mkAgent "plan-reviewer" [ I T ])
    (mkAgent "implement-worker" [ I T ])
    (mkAgent "implement-reviewer" [ I T ])
    (mkAgent "implement-conflict-resolver" [ I T ])
    (mkAgent "investigate-explorer" [ I T ])
    (mkAgent "investigate-prober" [ I T ])
    (mkAgent "research-explorer" [ I T ])
    (mkAgent "research-experimenter" [ T ])
    (mkCommand "begin" [ I T R ] [
      (recursion "plan")
      (recursion "plan/follow-up")
      (recursion "investigate")
      (recursion "research")
      (recursion "advance")
    ])
    (mkCommand "advance" [ I T O R ] [
      (recursion "investigate/advance")
      (recursion "plan/advance")
      (recursion "research/advance")
      (recursion "implement/advance")
    ])
    (mkCommand "plan" [ I T D R ] [
      (dispatch "plan-advance")
      (recursion "investigate/advance")
    ])
    (mkCommand "plan/advance" [ I T O D R ] [
      (dispatch "plan-advance")
      (dispatch "plan-reviewer")
      (recursion "investigate/advance")
    ])
    (mkCommand "plan/follow-up" [ I T D R ] [
      (dispatch "plan-advance")
      (recursion "investigate/advance")
    ])
    (mkCommand "investigate" [ I T R ] [
      (recursion "investigate/advance")
    ])
    (mkCommand "investigate/advance" [ I T O D ] [
      (dispatch "investigate-explorer")
      (dispatch "investigate-prober")
    ])
    (mkCommand "research" [ I T R ] [
      (recursion "research/advance")
    ])
    (mkCommand "research/advance" [ I T O D ] [
      (dispatch "research-explorer")
      (dispatch "research-experimenter")
    ])
    (mkCommand "implement/start" [ I T R ] [
      (recursion "implement/advance")
    ])
    (mkCommand "implement/advance" [ I T O D ] [
      (dispatch "implement-worker")
      (dispatch "implement-reviewer")
      (dispatch "implement-conflict-resolver")
    ])
    (mkCommand "plan-review" [ T ] [ ])
    (mkCommand "implement-review" [ I ] [ ])
    (mkCommand "planners" [ I T ] [ ])
    (mkCommand "reviewers" [ I T ] [ ])
  ];

  expectedAgentIds = builtins.attrNames agents;
  expectedCommandIds = map (lib.removePrefix "cq/") (
    lib.filter (lib.hasPrefix "cq/") (builtins.attrNames commands)
  );
  expectedRoleIds = expectedAgentIds ++ expectedCommandIds;

  validateBinding =
    rolePath: binding:
    if !builtins.isAttrs binding then
      fail rolePath "expected an attribute set"
    else if builtins.attrNames binding != [
      "forbiddenVocabulary"
      "fragment"
      "intentionalDifference"
      "sourceBlock"
      "supportedSurfaces"
    ] then
      fail rolePath "expected exactly fragment, sourceBlock, supportedSurfaces, forbiddenVocabulary, and intentionalDifference"
    else if !builtins.isString binding.fragment || !(builtins.hasAttr binding.fragment fragmentContractsById) then
      fail "${rolePath}.fragment" "unknown fragment reference"
    else if binding != mkFragmentBinding binding.fragment then
      fail rolePath "fragment binding does not match its typed contract"
    else
      binding;

  validateRole =
    index: role:
    let
      rolePath = "catalog[${toString index}]";
      expectedKind =
        if builtins.elem role.roleId expectedAgentIds then
          "dispatched-subagent"
        else
          "orchestrator-command";
      expectedSource =
        if expectedKind == "dispatched-subagent" then
          "agents/${role.roleId}.md"
        else
          "commands/cq/${role.roleId}.md";
      expectedName =
        if expectedKind == "dispatched-subagent" then
          role.roleId
        else
          "/cq:${lib.replaceStrings [ "/" ] [ ":" ] role.roleId}";
      validatedBindings = lib.imap0 (
        bindingIndex: validateBinding "${rolePath}.fragmentBindings[${toString bindingIndex}]"
      ) role.fragmentBindings;
      bindingFragments = map (binding: binding.fragment) validatedBindings;
      expectedDifferences = unique (
        map (binding: binding.intentionalDifference) validatedBindings
      );
    in
    if !builtins.isAttrs role then
      fail rolePath "expected an attribute set"
    else if builtins.attrNames role != [
      "canonicalSource"
      "dispatchRelations"
      "fragmentBindings"
      "intentionalDifferences"
      "name"
      "roleId"
      "roleKind"
      "sharedSourceBlock"
      "sidecar"
      "surfaces"
    ] then
      fail rolePath "unexpected catalog entry shape"
    else if !builtins.isString role.roleId || !(builtins.elem role.roleId expectedRoleIds) then
      fail "${rolePath}.roleId" "unknown inventoried role"
    else if role.roleKind != expectedKind then
      fail "${rolePath}.roleKind" "expected ${expectedKind}"
    else if role.name != expectedName then
      fail "${rolePath}.name" "does not match the role identity"
    else if role.canonicalSource != expectedSource || !builtins.pathExists (./. + "/${role.canonicalSource}") then
      fail "${rolePath}.canonicalSource" "invalid canonical source reference"
    else if role.surfaces != promptSurfaces then
      fail "${rolePath}.surfaces" "expected every prompt surface exactly once in canonical order"
    else if role.sharedSourceBlock != sharedSourceBlock then
      fail "${rolePath}.sharedSourceBlock" "does not match the canonical shared-prose contract"
    else if !builtins.isList role.fragmentBindings then
      fail "${rolePath}.fragmentBindings" "expected a list"
    else if builtins.length bindingFragments != builtins.length (unique bindingFragments) then
      fail "${rolePath}.fragmentBindings" "duplicate fragment reference"
    else if role.intentionalDifferences != expectedDifferences then
      fail "${rolePath}.intentionalDifferences" "does not match fragment declarations"
    else if
      expectedKind == "dispatched-subagent"
      && (
        !builtins.isAttrs role.sidecar
        || builtins.attrNames role.sidecar != [ "schemaRoleId" ]
        || role.sidecar.schemaRoleId != role.roleId
        || !(builtins.elem role.sidecar.schemaRoleId expectedAgentIds)
      )
    then
      fail "${rolePath}.sidecar" "invalid dispatched-role sidecar reference"
    else if expectedKind == "orchestrator-command" && role.sidecar != null then
      fail "${rolePath}.sidecar" "orchestrator commands must not reference a sidecar"
    else if !builtins.isList role.dispatchRelations then
      fail "${rolePath}.dispatchRelations" "expected a list"
    else
      builtins.deepSeq validatedBindings role;

  validatePromptCatalog =
    value:
    if !builtins.isList value then
      fail "catalog" "expected an ordered list"
    else
      let
        roles = lib.imap0 validateRole value;
        roleIds = map (role: role.roleId) roles;
        sources = map (role: role.canonicalSource) roles;
        validateRelation =
          role: relationIndex: relation:
          let
            relationPath = "catalog.${role.roleId}.dispatchRelations[${toString relationIndex}]";
            target = lib.findFirst (candidate: candidate.roleId == relation.targetRoleId) null roles;
          in
          if !builtins.isAttrs relation then
            fail relationPath "expected an attribute set"
          else if builtins.attrNames relation != [
            "kind"
            "targetRoleId"
          ] then
            fail relationPath "expected exactly kind and targetRoleId"
          else if relation.kind != "dispatch" && relation.kind != "recursion" then
            fail "${relationPath}.kind" "expected dispatch or recursion"
          else if !builtins.isString relation.targetRoleId || target == null then
            fail "${relationPath}.targetRoleId" "unknown dispatch reference"
          else if relation.kind == "dispatch" && target.roleKind != "dispatched-subagent" then
            fail relationPath "dispatch must target a dispatched subagent"
          else if relation.kind == "recursion" && target.roleKind != "orchestrator-command" then
            fail relationPath "recursion must target an orchestrator command"
          else
            relation;
        validatedRelations = map (
          role: lib.imap0 (validateRelation role) role.dispatchRelations
        ) roles;
      in
      if builtins.length roleIds != builtins.length (unique roleIds) then
        fail "catalog" "duplicate role identity"
      else if builtins.length sources != builtins.length (unique sources) then
        fail "catalog" "duplicate canonical source"
      else if lib.sort builtins.lessThan roleIds != lib.sort builtins.lessThan expectedRoleIds then
        fail "catalog" "must contain every inventoried role exactly once"
      else
        builtins.deepSeq validatedRelations roles;

  catalog = validatePromptCatalog authoredCatalog;
  catalogJson = builtins.toJSON catalog;
  agentCatalogJson = builtins.toJSON (
    lib.filter (role: role.roleKind == "dispatched-subagent") catalog
  );
  orchestratorCatalogJson = builtins.toJSON (
    lib.filter (role: role.roleKind == "orchestrator-command") catalog
  );
  catalogMetadataHash = builtins.hashString "sha256" catalogJson;
  promptFragmentSource =
    surface: role: binding:
    if surface == "claude" && binding.fragment == T then
      if role.roleKind == "dispatched-subagent" then
        "fragments/${surface}/agents/${role.roleId}/${binding.fragment}.md"
      else
        "fragments/${surface}/commands/cq/${role.roleId}/${binding.fragment}.md"
    else if surface == "pi" && role.roleKind == "dispatched-subagent" && binding.fragment == T then
      "fragments/${surface}/agents/${role.roleId}/${binding.fragment}.md"
    else
      "fragments/${surface}/${binding.fragment}.md";
  rawPromptFragmentSources = lib.concatMap (
    surface:
    lib.concatMap (
      role:
      map (binding: {
        inherit surface;
        inherit (role) roleId;
        inherit (binding) fragment;
        source = promptFragmentSource surface role binding;
      }) role.fragmentBindings
    ) catalog
  ) promptSurfaces;
  promptFragmentSourceKeys = map (
    entry: "${entry.surface}:${entry.roleId}:${entry.fragment}"
  ) rawPromptFragmentSources;
  promptFragmentSources =
    if builtins.length promptFragmentSourceKeys != builtins.length (unique promptFragmentSourceKeys) then
      fail "promptFragmentSources" "duplicate surface, role, and fragment identity"
    else
      map (
        entry:
        if builtins.pathExists (./. + "/${entry.source}") then
          entry
        else
          fail "promptFragmentSources.${entry.surface}.${entry.roleId}.${entry.fragment}"
            "missing fragment source \"${entry.source}\""
      ) rawPromptFragmentSources;
  promptFragmentSourcesJson = builtins.toJSON promptFragmentSources;
  promptCatalogProjection = {
    schemaVersion = 1;
    inherit catalog catalogMetadataHash fragmentContracts;
  };

  promptSurfaceLayout = map (
    surface:
    let
      root = "$out/share/cq/prompt-surfaces/${surface}";
    in
    {
      inherit surface root;
      catalog = "${root}/catalog.json";
      surfaceMetadata = "${root}/surface.json";
      roles = "${root}/roles";
      roleArtifacts = map (role: {
        roleId = role.roleId;
        path = "${root}/roles/${role.roleId}.md";
      }) catalog;
    }
  ) promptSurfaces;
in
assert builtins.length fragmentContractIds == builtins.length (unique fragmentContractIds);
assert lib.sort builtins.lessThan fragmentContractIds
  == builtins.attrNames sourceBlockByFragment;
{
  inherit
    commands
    agents
    catalog
    catalogJson
    agentCatalogJson
    orchestratorCatalogJson
    catalogMetadataHash
    fragmentContracts
    promptCatalogProjection
    promptFragmentSources
    promptFragmentSourcesJson
    promptSurfaceLayout
    promptSurfaces
    validatePromptCatalog
    ;
  skills = lib.genAttrs skillNames mkSkill;
  context = lib.optional (builtins.pathExists ./context.md) (builtins.readFile ./context.md);
}
