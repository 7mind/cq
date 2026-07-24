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
  roleReferenceName =
    role:
    if role.roleKind == commandRoleKind then
      "${skillName role.roleId}.md"
    else
      "role-${role.roleId}.md";
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

  mkReferenceLine =
    role:
    let
      referenceName = roleReferenceName role;
    in
    if role.roleKind == commandRoleKind then
      "- `${"$"}${skillName role.roleId}` → [`references/${referenceName}`](references/${referenceName})"
    else
      "- Codex collaboration role `${role.roleId}` → [`references/${referenceName}`](references/${referenceName})";

  mkSkillSpec =
    role:
    let
      name = skillName role.roleId;
      invocation = "$" + name;
      closureIds = closureRoleIds role.roleId;
      closureRoles = builtins.filter (
        candidate: builtins.elem candidate.roleId closureIds
      ) validatedCatalog;
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

        Every `CQ_SUBAGENT` role in the workflow names the corresponding Codex
        collaboration-role reference below. Read that role reference completely
        before dispatching it through the collaboration transport described by
        the workflow.

        ## Workflow references

        ${lib.concatMapStringsSep "\n" mkReferenceLine closureRoles}
      '';
      references = lib.listToAttrs (
        map (
          dependencyRole:
          lib.nameValuePair
            (roleReferenceName dependencyRole)
            "${promptRoot}/roles/${dependencyRole.roleId}.md"
        ) closureRoles
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
  inherit roles skills;
  catalog = "${promptRoot}/catalog.json";
}
