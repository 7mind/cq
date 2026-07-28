{ lib }:
{
  catalog,
  promptRoot,
}:
let
  fail = path: detail: throw "Codex skill projection: ${path}: ${detail}";
  unique =
    values:
    builtins.foldl' (
      result: value:
      if builtins.elem value result then result else result ++ [ value ]
    ) [ ] values;

  commandRoleKind = "orchestrator-command";
  dispatchedRoleKind = "dispatched-subagent";
  supportedRoleKinds = [
    dispatchedRoleKind
    commandRoleKind
  ];
  supportedRelationKinds = [
    "dispatch"
    "recursion"
  ];

  validateRole =
    index: role:
    let
      rolePath = "catalog[${toString index}]";
      validateRelation =
        relationIndex: relation:
        let
          relationPath = "${rolePath}.dispatchRelations[${toString relationIndex}]";
        in
        if !builtins.isAttrs relation then
          fail relationPath "expected an attribute set"
        else if builtins.attrNames relation != [
          "kind"
          "targetRoleId"
        ] then
          fail relationPath "expected exactly kind and targetRoleId"
        else if !(builtins.elem relation.kind supportedRelationKinds) then
          fail "${relationPath}.kind" "unsupported Codex capability \"${toString relation.kind}\""
        else if !builtins.isString relation.targetRoleId || relation.targetRoleId == "" then
          fail "${relationPath}.targetRoleId" "expected a non-empty role id"
        else
          relation;
      validatedRelations = lib.imap0 validateRelation role.dispatchRelations;
    in
    if !builtins.isAttrs role then
      fail rolePath "expected an attribute set"
    else if !builtins.isString role.roleId || builtins.match "^[a-z0-9-]+(/[a-z0-9-]+)*$" role.roleId == null then
      fail "${rolePath}.roleId" "expected a safe role id"
    else if !(builtins.elem role.roleKind supportedRoleKinds) then
      fail "${rolePath}.roleKind" "unsupported Codex role capability \"${toString role.roleKind}\""
    else if !builtins.isList role.surfaces || !(builtins.elem "codex" role.surfaces) then
      fail "${rolePath}.surfaces" "Codex is not a supported surface"
    else if
      role.roleKind == dispatchedRoleKind
      && (
        !builtins.isAttrs role.sidecar
        || builtins.attrNames role.sidecar != [ "schemaRoleId" ]
        || role.sidecar.schemaRoleId != role.roleId
      )
    then
      fail "${rolePath}.sidecar" "expected the shared schema sidecar for this role"
    else if role.roleKind == commandRoleKind && role.sidecar != null then
      fail "${rolePath}.sidecar" "orchestrator commands cannot carry schema sidecars"
    else if !builtins.isList role.dispatchRelations then
      fail "${rolePath}.dispatchRelations" "expected a list"
    else
      builtins.deepSeq validatedRelations role;

  validatedCatalog =
    if !builtins.isList catalog then
      fail "catalog" "expected the direct assets.nix.catalog list"
    else
      lib.imap0 validateRole catalog;
  roleIds = map (role: role.roleId) validatedCatalog;
  roleById = lib.listToAttrs (
    map (role: lib.nameValuePair role.roleId role) validatedCatalog
  );

  validateRelationTarget =
    role: relationIndex: relation:
    let
      relationPath = "catalog.${role.roleId}.dispatchRelations[${toString relationIndex}]";
      target = roleById.${relation.targetRoleId} or null;
      expectedTargetKind =
        if relation.kind == "dispatch" then dispatchedRoleKind else commandRoleKind;
    in
    if target == null then
      fail "${relationPath}.targetRoleId" "unknown role \"${relation.targetRoleId}\""
    else if target.roleKind != expectedTargetKind then
      fail relationPath "${relation.kind} must target a ${expectedTargetKind} role"
    else
      relation;
  validatedRelations = map (
    role: lib.imap0 (validateRelationTarget role) role.dispatchRelations
  ) validatedCatalog;

  skillName =
    roleId:
    "cq-${lib.replaceStrings [ "/" ] [ "-" ] roleId}";
  # Only an orchestrator command has a skill-local reference. A dispatched role
  # deliberately has NONE (defects:D178 half (a)): its body reaches its child
  # through the global native-agent declaration below, never through a path this
  # skill hands the parent. Asking for one is an authoring error, so it fails at
  # eval rather than silently re-advertising a role body.
  roleReferenceName =
    role:
    if role.roleKind == commandRoleKind then
      "${skillName role.roleId}.md"
    else
      fail "catalog.${role.roleId}" "a dispatched role has no skill reference (defects:D178)";
  commandRoles = builtins.filter (
    role: role.roleKind == commandRoleKind
  ) validatedCatalog;
  dispatchedRoles = builtins.filter (
    role: role.roleKind == dispatchedRoleKind
  ) validatedCatalog;
  skillNames = map (role: skillName role.roleId) commandRoles;
  validSkillName =
    name: builtins.match "^[a-z0-9]+(-[a-z0-9]+)*$" name != null;

  closureRoleIds =
    rootRoleId:
    let
      visit =
        visited: pending:
        if pending == [ ] then
          visited
        else
          let
            current = builtins.head pending;
            relations = roleById.${current}.dispatchRelations;
            targets = map (relation: relation.targetRoleId) relations;
            unseen = builtins.filter (
              roleId: !(builtins.elem roleId visited) && !(builtins.elem roleId (builtins.tail pending))
            ) targets;
          in
          if builtins.elem current visited then
            visit visited (builtins.tail pending)
          else
            visit (visited ++ [ current ]) ((builtins.tail pending) ++ unseen);
      reachable = visit [ ] [ rootRoleId ];
    in
    builtins.filter (roleId: builtins.elem roleId reachable) roleIds;

  # Advertises ONE command-role reference. defects:D178 keeps this branch
  # verbatim — inline `CQ::<path>` recursion genuinely needs these paths, and the
  # researches:RS10/RS11 ablation says nothing about them. The dispatched-role
  # branch that used to live here is gone; see `advertisedRoles` below.
  mkReferenceLine =
    role:
    let
      referenceName = roleReferenceName role;
    in
    "- `${"$"}${skillName role.roleId}` → [`references/${referenceName}`](references/${referenceName})";

  mkSkillSpec =
    role:
    let
      name = skillName role.roleId;
      invocation = "$" + name;
      closureIds = closureRoleIds role.roleId;
      closureRoles = builtins.filter (
        candidate: builtins.elem candidate.roleId closureIds
      ) validatedCatalog;
      # defects:D178 half (a). researches:RS10 corrected the root cause and
      # researches:RS11 confirmed it at real scale: ADVERTISING a role name -> path
      # mapping is what makes the parent batch-read the bodies before it dispatches
      # anything, and it pulls in EVERY advertised body rather than the dispatched
      # one (ROLEBODY 1,1,1 / EXPBODY 1,1,1 in the control; 0 of 110,553 B kept out
      # of parent context). So the projection advertises — and ships — only the
      # command-role references. Dispatched bodies travel by native agent instead.
      advertisedRoles = builtins.filter (
        candidate: candidate.roleKind == commandRoleKind
      ) closureRoles;
      entryReferenceName = roleReferenceName role;
    in
    {
      skillMd = ''
        ---
        name: ${name}
        description: "CQ workflow ${role.roleId}. Invoke explicitly as ${invocation}."
        ---

        # Codex workflow adapter

        Read [`references/${entryReferenceName}`](references/${entryReferenceName})
        completely, then execute that workflow.

        Treat text accompanying `${invocation}` in the user's request as
        `$ARGUMENTS` in the entry workflow.

        Every `CQ::<path>` token in the workflow names the corresponding `$cq-*`
        reference listed below. When a source says to run or execute one INLINE,
        read that reference completely and execute it in this session before
        resuming the caller. Preserve arguments following the token.

        Every `CQ_SUBAGENT` role in the workflow is a globally declared Codex
        collaboration agent whose id is the role id. Dispatch it with
        `spawn_agent` and pass only its task input; the transport delivers that
        role's instructions to the child directly. Its body is deliberately NOT
        readable from this skill, and you must not reconstruct, summarise, or
        inline it — dispatch the agent by id instead.

        ## Workflow references

        ${lib.concatMapStringsSep "\n" mkReferenceLine advertisedRoles}
      '';
      references = lib.listToAttrs (
        map (
          dependencyRole:
          lib.nameValuePair
            (roleReferenceName dependencyRole)
            "${promptRoot}/roles/${dependencyRole.roleId}.md"
        ) advertisedRoles
      );
      roleIds = closureIds;
    };

  skills = lib.listToAttrs (
    map (
      role: lib.nameValuePair (skillName role.roleId) (mkSkillSpec role)
    ) commandRoles
  );
  roles = lib.listToAttrs (
    map (
      role:
      lib.nameValuePair role.roleId {
        prompt = "${promptRoot}/roles/${role.roleId}.md";
        inherit (role) sidecar;
      }
    ) dispatchedRoles
  );

  # defects:D178 half (b) — INSEPARABLE from half (a) above. researches:RS11
  # recommendation #1: "Never ship (a) alone — it removes the leak and leaves
  # children un-roled", and RS11 measured what un-roled costs at real scale (the
  # uninstructed child read the skill index, executed the 43.5 KB ORCHESTRATOR
  # workflow, then FAILED trying to spawn its own subagent). So suppressing the
  # advertisement obliges this projection to supply the delivery mechanism that
  # replaces it.
  #
  # The shape is the one researches:RS11 ARM 3-real MEASURED against the real
  # 43,567 B closure: a standalone GLOBAL $CODEX_HOME/agents/<name>.toml carrying
  # name / description / developer_instructions, dispatched as
  # spawn_agent({agent_type}). That arm gave ROLEBODY 0/3 in the parent stream AND
  # the parent rollout, CHILDSAW 3/3 with the body arriving as the child's first
  # `role: developer` message and ZERO child tool calls, and showed the parent only
  # the one-line description. A project-scoped `.codex/agents/` declaration is NOT
  # a substitute: it is advertised but UNSPAWNABLE on codex-cli 0.145.0
  # (openai/codex#26408, still OPEN), which is why both studies used the global dir.
  #
  # Every value below is the TOML field verbatim EXCEPT `developer_instructions`,
  # which is the store path whose bytes the writer inlines as the field's
  # multi-line literal. That is the same path-then-copy shape `references` above
  # uses, and it keeps this projection free of import-from-derivation: inlining the
  # body here would force the rendered prompt root to be built during evaluation.
  mkAgentDeclaration =
    role:
    {
      name = role.roleId;
      description = "CQ dispatched collaboration role ${role.roleId}. Spawned by a CQ workflow; not for direct invocation.";
      developer_instructions = "${promptRoot}/roles/${role.roleId}.md";
    };
  agents = lib.listToAttrs (
    map (role: lib.nameValuePair role.roleId (mkAgentDeclaration role)) dispatchedRoles
  );
in
assert lib.assertMsg (
  builtins.length roleIds == builtins.length (unique roleIds)
) "Codex skill projection: catalog role ids must be unique";
assert lib.assertMsg (
  builtins.length skillNames == builtins.length (unique skillNames)
) "Codex skill projection: command role ids collide after replacing `/` with `-`";
assert lib.assertMsg (lib.all validSkillName skillNames)
  "Codex skill projection: a command role id does not map to a valid skill name";
builtins.deepSeq validatedRelations {
  inherit agents roles skills;
  catalog = "${promptRoot}/catalog.json";
}
