{ lib }:
commands:
let
  cqCommands = lib.filterAttrs (key: _: lib.hasPrefix "cq/" key) commands;

  commandKeyToSkillName = key: lib.replaceStrings [ "/" ] [ "-" ] key;
  commandKeyToClaudeInvocation = key: "/${lib.replaceStrings [ "/" ] [ ":" ] key}";
  commandKeyToSkillInvocation = key: "$" + commandKeyToSkillName key;

  commandKeys = builtins.attrNames cqCommands;
  skillNames = map commandKeyToSkillName commandKeys;
  validSkillName = name: builtins.match "^[a-z0-9]+(-[a-z0-9]+)*$" name != null;

  cqInvocations =
    body:
    lib.unique (
      lib.concatMap (part: if builtins.isList part then part else [ ]) (
        builtins.split "(/cq:[a-z0-9][a-z0-9:-]*)" body
      )
    );

  invocationToCommandKey =
    invocation:
    lib.replaceStrings [ ":" ] [ "/" ] (lib.removePrefix "/" invocation);

  commandReferences = body: map invocationToCommandKey (cqInvocations body);
  referencesByCommand = lib.mapAttrs (_: body: commandReferences body) cqCommands;
  unresolvedReferences = lib.unique (
    lib.concatMap (
      key: lib.filter (reference: !(builtins.hasAttr reference cqCommands)) referencesByCommand.${key}
    ) commandKeys
  );

  dependencyClosure =
    root:
    let
      visit =
        visited: pending:
        if pending == [ ] then
          visited
        else
          let
            current = builtins.head pending;
            unseen = lib.filter (key: !(builtins.elem key visited)) referencesByCommand.${current};
          in
          visit (visited ++ unseen) ((builtins.tail pending) ++ unseen);
    in
    visit [ root ] [ root ];

  invocationKeysByLength = lib.sort (
    left: right:
    builtins.stringLength (commandKeyToClaudeInvocation left)
    > builtins.stringLength (commandKeyToClaudeInvocation right)
  ) commandKeys;

  renderCommandBody =
    body:
    builtins.replaceStrings
      (map commandKeyToClaudeInvocation invocationKeysByLength)
      (map commandKeyToSkillInvocation invocationKeysByLength)
      body;

  commandDescription =
    key: body:
    let
      descriptionLine = lib.findFirst (line: lib.hasPrefix "description: " line) null (
        lib.splitString "\n" body
      );
    in
    if descriptionLine == null then
      throw "Codex skill projection: command `${key}` has no `description:` frontmatter field"
    else
      lib.removePrefix "description: " descriptionLine;

  mkSkillSpec =
    key: body:
    let
      skillName = commandKeyToSkillName key;
      skillInvocation = commandKeyToSkillInvocation key;
      dependencyKeys = dependencyClosure key;
      referenceName = dependencyKey: "${commandKeyToSkillName dependencyKey}.md";
      referenceLines = lib.concatMapStringsSep "\n" (
        dependencyKey:
        "- `${commandKeyToSkillInvocation dependencyKey}` → "
        + "[`references/${referenceName dependencyKey}`]"
        + "(references/${referenceName dependencyKey})"
      ) dependencyKeys;
      description = "${renderCommandBody (commandDescription key body)} Invoke explicitly as ${skillInvocation}.";
    in
    {
      skillMd = ''
        ---
        name: ${skillName}
        description: ${builtins.toJSON description}
        ---

        # Codex workflow adapter

        Read [`references/${referenceName key}`](references/${referenceName key})
        completely, then execute that workflow.

        Treat text accompanying `${skillInvocation}` in the user's request as
        `$ARGUMENTS` in the entry workflow.

        Every `$cq-*` token in the workflow sources names a workflow reference
        listed below. When a source says to run or execute one **INLINE**, read the
        mapped reference completely and execute it in this session before resuming
        the caller. Treat arguments written after that token as `$ARGUMENTS` for the
        referenced workflow. Resolve nested INLINE references by the same rule. Do
        not attempt to invoke a nested skill through the UI, merely paraphrase it,
        or ask the user to invoke it.

        When a source tells the user to run or re-run a workflow, report its native
        `$cq-*` invocation exactly as rendered in the source, preserving arguments.

        ## Workflow references

        ${referenceLines}
      '';
      references = lib.listToAttrs (
        map (dependencyKey: {
          name = referenceName dependencyKey;
          value = renderCommandBody cqCommands.${dependencyKey};
        }) dependencyKeys
      );
    };
in
assert lib.assertMsg (
  builtins.length skillNames == builtins.length (lib.unique skillNames)
) "Codex skill projection: cq command keys collide after replacing `/` with `-`";
assert lib.assertMsg (lib.all validSkillName skillNames)
  "Codex skill projection: a cq command key does not map to a valid skill name";
assert lib.assertMsg (
  unresolvedReferences == [ ]
) "Codex skill projection: unresolved cq command references: ${lib.concatStringsSep ", " unresolvedReferences}";
lib.mapAttrs' (key: body: lib.nameValuePair (commandKeyToSkillName key) (mkSkillSpec key body)) cqCommands
