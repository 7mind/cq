/**
 * GENERATED from nix/pkg/cq-assets/assets.nix — DO NOT EDIT.
 *
 * Regenerate with `bun run gen-prompt-catalog`. This compile-time mirror is
 * never an input to Nix prompt renderer derivations.
 */

export const PROMPT_CATALOG_PROJECTION = {
  "catalog": [
    {
      "canonicalSource": "agents/plan-advance.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "store_result"
            ],
            "codex": [
              "fenced object",
              "final content"
            ],
            "pi": [
              "store_result"
            ]
          },
          "fragment": "dispatch-result-delivery",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "dispatched child input retrieval and structured-result transport",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "plan-advance",
      "roleId": "plan-advance",
      "roleKind": "dispatched-subagent",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": {
        "schemaRoleId": "plan-advance"
      },
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "agents/plan-reviewer.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "store_result"
            ],
            "codex": [
              "fenced object",
              "final content"
            ],
            "pi": [
              "store_result"
            ]
          },
          "fragment": "dispatch-result-delivery",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "dispatched child input retrieval and structured-result transport",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "plan-reviewer",
      "roleId": "plan-reviewer",
      "roleKind": "dispatched-subagent",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": {
        "schemaRoleId": "plan-reviewer"
      },
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "agents/implement-worker.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "input delivered via dispatch prompt"
            ],
            "codex": [
              "input delivered via dispatch prompt"
            ],
            "pi": [
              "fetch_dispatch_input",
              "inputCapability",
              "prepare_dispatch"
            ]
          },
          "fragment": "dispatch-input-delivery",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Claude and Codex retrieve prepare-bound worker input through the one-shot capability, while Pi retains its held direct-prompt protocol until the coordinated extension migration.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "implementation child-side input retrieval procedure",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Claude and Codex retrieve prepare-bound worker input through the one-shot capability, while Pi retains its held direct-prompt protocol until the coordinated extension migration.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "implement-worker",
      "roleId": "implement-worker",
      "roleKind": "dispatched-subagent",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": {
        "schemaRoleId": "implement-worker"
      },
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "agents/implement-reviewer.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "input delivered via dispatch prompt"
            ],
            "codex": [
              "input delivered via dispatch prompt"
            ],
            "pi": [
              "fetch_dispatch_input",
              "inputCapability",
              "prepare_dispatch"
            ]
          },
          "fragment": "dispatch-input-delivery",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Claude and Codex retrieve prepare-bound worker input through the one-shot capability, while Pi retains its held direct-prompt protocol until the coordinated extension migration.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "implementation child-side input retrieval procedure",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Claude and Codex retrieve prepare-bound worker input through the one-shot capability, while Pi retains its held direct-prompt protocol until the coordinated extension migration.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "implement-reviewer",
      "roleId": "implement-reviewer",
      "roleKind": "dispatched-subagent",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": {
        "schemaRoleId": "implement-reviewer"
      },
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "agents/implement-conflict-resolver.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "input delivered via dispatch prompt"
            ],
            "codex": [
              "input delivered via dispatch prompt"
            ],
            "pi": [
              "fetch_dispatch_input",
              "inputCapability",
              "prepare_dispatch"
            ]
          },
          "fragment": "dispatch-input-delivery",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Claude and Codex retrieve prepare-bound worker input through the one-shot capability, while Pi retains its held direct-prompt protocol until the coordinated extension migration.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "implementation child-side input retrieval procedure",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Claude and Codex retrieve prepare-bound worker input through the one-shot capability, while Pi retains its held direct-prompt protocol until the coordinated extension migration.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "implement-conflict-resolver",
      "roleId": "implement-conflict-resolver",
      "roleKind": "dispatched-subagent",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": {
        "schemaRoleId": "implement-conflict-resolver"
      },
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "agents/investigate-explorer.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [
              "command execution",
              "execute commands"
            ],
            "pi": []
          },
          "fragment": "explorer-static-inspection",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Codex explorers need a static shell fallback when the harness exposes no dedicated filesystem reader, while Claude and Pi keep shell access disabled.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "explorer-only static repository inspection policy",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "store_result"
            ],
            "codex": [
              "fenced object",
              "final content"
            ],
            "pi": [
              "store_result"
            ]
          },
          "fragment": "dispatch-result-delivery",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "dispatched child input retrieval and structured-result transport",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Codex explorers need a static shell fallback when the harness exposes no dedicated filesystem reader, while Claude and Pi keep shell access disabled.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "investigate-explorer",
      "roleId": "investigate-explorer",
      "roleKind": "dispatched-subagent",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": {
        "schemaRoleId": "investigate-explorer"
      },
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "agents/investigate-prober.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "store_result"
            ],
            "codex": [
              "fenced object",
              "final content"
            ],
            "pi": [
              "store_result"
            ]
          },
          "fragment": "dispatch-result-delivery",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "dispatched child input retrieval and structured-result transport",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "investigate-prober",
      "roleId": "investigate-prober",
      "roleKind": "dispatched-subagent",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": {
        "schemaRoleId": "investigate-prober"
      },
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "agents/research-explorer.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [
              "command execution",
              "execute commands"
            ],
            "pi": []
          },
          "fragment": "explorer-static-inspection",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Codex explorers need a static shell fallback when the harness exposes no dedicated filesystem reader, while Claude and Pi keep shell access disabled.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "explorer-only static repository inspection policy",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "store_result"
            ],
            "codex": [
              "fenced object",
              "final content"
            ],
            "pi": [
              "store_result"
            ]
          },
          "fragment": "dispatch-result-delivery",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "dispatched child input retrieval and structured-result transport",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Codex explorers need a static shell fallback when the harness exposes no dedicated filesystem reader, while Claude and Pi keep shell access disabled.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "research-explorer",
      "roleId": "research-explorer",
      "roleKind": "dispatched-subagent",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": {
        "schemaRoleId": "research-explorer"
      },
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "agents/research-experimenter.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "store_result"
            ],
            "codex": [
              "fenced object",
              "final content"
            ],
            "pi": [
              "store_result"
            ]
          },
          "fragment": "dispatch-result-delivery",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "dispatched child input retrieval and structured-result transport",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "research-experimenter",
      "roleId": "research-experimenter",
      "roleKind": "dispatched-subagent",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": {
        "schemaRoleId": "research-experimenter"
      },
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/begin.md",
      "dispatchRelations": [
        {
          "kind": "recursion",
          "targetRoleId": "plan"
        },
        {
          "kind": "recursion",
          "targetRoleId": "plan/follow-up"
        },
        {
          "kind": "recursion",
          "targetRoleId": "investigate"
        },
        {
          "kind": "recursion",
          "targetRoleId": "research"
        },
        {
          "kind": "recursion",
          "targetRoleId": "advance"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "fetch_prompt(",
              "$cq-"
            ],
            "codex": [
              "/cq:",
              "fetch_prompt("
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "inline-command-recursion",
          "intentionalDifference": {
            "kind": "recursion-protocol",
            "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "inline chained-command execution instructions",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "ledger-response-contract",
          "sourceBlock": "ledger item-read projection and mutation response contract",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "recursion-protocol",
          "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:begin",
      "roleId": "begin",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/advance.md",
      "dispatchRelations": [
        {
          "kind": "recursion",
          "targetRoleId": "investigate/advance"
        },
        {
          "kind": "recursion",
          "targetRoleId": "plan/advance"
        },
        {
          "kind": "recursion",
          "targetRoleId": "research/advance"
        },
        {
          "kind": "recursion",
          "targetRoleId": "implement/advance"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "mcp__ledger__",
              "Agent("
            ],
            "pi": [
              "mcp__ledger__",
              "Agent("
            ]
          },
          "fragment": "operational-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "body-level mapping from canonical operational tokens to callable host tools",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "fetch_prompt(",
              "$cq-"
            ],
            "codex": [
              "/cq:",
              "fetch_prompt("
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "inline-command-recursion",
          "intentionalDifference": {
            "kind": "recursion-protocol",
            "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "inline chained-command execution instructions",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [
              "cq-advance-active-"
            ],
            "pi": [
              "cq-advance-active-"
            ]
          },
          "fragment": "advance-run-guard",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Only the host with the CQ stop hook requires a session sentinel.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "surface-specific run guard lifecycle",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "recursion-protocol",
          "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Only the host with the CQ stop hook requires a session sentinel.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:advance",
      "roleId": "advance",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/plan.md",
      "dispatchRelations": [
        {
          "kind": "dispatch",
          "targetRoleId": "plan-advance"
        },
        {
          "kind": "recursion",
          "targetRoleId": "investigate/advance"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "Agent(",
              "dispatch_agent("
            ],
            "pi": [
              "Agent("
            ]
          },
          "fragment": "subagent-dispatch",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "subagent dispatch instructions and host transport branch",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "fetch_prompt(",
              "$cq-"
            ],
            "codex": [
              "/cq:",
              "fetch_prompt("
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "inline-command-recursion",
          "intentionalDifference": {
            "kind": "recursion-protocol",
            "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "inline chained-command execution instructions",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "ledger-response-contract",
          "sourceBlock": "ledger item-read projection and mutation response contract",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "recursion-protocol",
          "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:plan",
      "roleId": "plan",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/plan/advance.md",
      "dispatchRelations": [
        {
          "kind": "dispatch",
          "targetRoleId": "plan-advance"
        },
        {
          "kind": "dispatch",
          "targetRoleId": "plan-reviewer"
        },
        {
          "kind": "recursion",
          "targetRoleId": "investigate/advance"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "mcp__ledger__",
              "Agent("
            ],
            "pi": [
              "mcp__ledger__",
              "Agent("
            ]
          },
          "fragment": "operational-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "body-level mapping from canonical operational tokens to callable host tools",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "Agent(",
              "dispatch_agent("
            ],
            "pi": [
              "Agent("
            ]
          },
          "fragment": "subagent-dispatch",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "subagent dispatch instructions and host transport branch",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "fetch_prompt(",
              "$cq-"
            ],
            "codex": [
              "/cq:",
              "fetch_prompt("
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "inline-command-recursion",
          "intentionalDifference": {
            "kind": "recursion-protocol",
            "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "inline chained-command execution instructions",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "ledger-response-contract",
          "sourceBlock": "ledger item-read projection and mutation response contract",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "recursion-protocol",
          "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:plan:advance",
      "roleId": "plan/advance",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/plan/follow-up.md",
      "dispatchRelations": [
        {
          "kind": "dispatch",
          "targetRoleId": "plan-advance"
        },
        {
          "kind": "recursion",
          "targetRoleId": "investigate/advance"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "Agent(",
              "dispatch_agent("
            ],
            "pi": [
              "Agent("
            ]
          },
          "fragment": "subagent-dispatch",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "subagent dispatch instructions and host transport branch",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "fetch_prompt(",
              "$cq-"
            ],
            "codex": [
              "/cq:",
              "fetch_prompt("
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "inline-command-recursion",
          "intentionalDifference": {
            "kind": "recursion-protocol",
            "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "inline chained-command execution instructions",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "recursion-protocol",
          "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:plan:follow-up",
      "roleId": "plan/follow-up",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/investigate.md",
      "dispatchRelations": [
        {
          "kind": "recursion",
          "targetRoleId": "investigate/advance"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "fetch_prompt(",
              "$cq-"
            ],
            "codex": [
              "/cq:",
              "fetch_prompt("
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "inline-command-recursion",
          "intentionalDifference": {
            "kind": "recursion-protocol",
            "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "inline chained-command execution instructions",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "recursion-protocol",
          "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:investigate",
      "roleId": "investigate",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/investigate/advance.md",
      "dispatchRelations": [
        {
          "kind": "dispatch",
          "targetRoleId": "investigate-explorer"
        },
        {
          "kind": "dispatch",
          "targetRoleId": "investigate-prober"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "mcp__ledger__",
              "Agent("
            ],
            "pi": [
              "mcp__ledger__",
              "Agent("
            ]
          },
          "fragment": "operational-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "body-level mapping from canonical operational tokens to callable host tools",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "Agent(",
              "dispatch_agent("
            ],
            "pi": [
              "Agent("
            ]
          },
          "fragment": "subagent-dispatch",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "subagent dispatch instructions and host transport branch",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:investigate:advance",
      "roleId": "investigate/advance",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/research.md",
      "dispatchRelations": [
        {
          "kind": "recursion",
          "targetRoleId": "research/advance"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "fetch_prompt(",
              "$cq-"
            ],
            "codex": [
              "/cq:",
              "fetch_prompt("
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "inline-command-recursion",
          "intentionalDifference": {
            "kind": "recursion-protocol",
            "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "inline chained-command execution instructions",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "ledger-response-contract",
          "sourceBlock": "ledger item-read projection and mutation response contract",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "recursion-protocol",
          "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:research",
      "roleId": "research",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/research/advance.md",
      "dispatchRelations": [
        {
          "kind": "dispatch",
          "targetRoleId": "research-explorer"
        },
        {
          "kind": "dispatch",
          "targetRoleId": "research-experimenter"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "mcp__ledger__",
              "Agent("
            ],
            "pi": [
              "mcp__ledger__",
              "Agent("
            ]
          },
          "fragment": "operational-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "body-level mapping from canonical operational tokens to callable host tools",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "Agent(",
              "dispatch_agent("
            ],
            "pi": [
              "Agent("
            ]
          },
          "fragment": "subagent-dispatch",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "subagent dispatch instructions and host transport branch",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "ledger-response-contract",
          "sourceBlock": "ledger item-read projection and mutation response contract",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:research:advance",
      "roleId": "research/advance",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/implement/start.md",
      "dispatchRelations": [
        {
          "kind": "recursion",
          "targetRoleId": "implement/advance"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "fetch_prompt(",
              "$cq-"
            ],
            "codex": [
              "/cq:",
              "fetch_prompt("
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "inline-command-recursion",
          "intentionalDifference": {
            "kind": "recursion-protocol",
            "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "inline chained-command execution instructions",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "recursion-protocol",
          "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:implement:start",
      "roleId": "implement/start",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/implement/advance.md",
      "dispatchRelations": [
        {
          "kind": "dispatch",
          "targetRoleId": "implement-worker"
        },
        {
          "kind": "dispatch",
          "targetRoleId": "implement-reviewer"
        },
        {
          "kind": "dispatch",
          "targetRoleId": "implement-conflict-resolver"
        }
      ],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "mcp__ledger__",
              "Agent("
            ],
            "pi": [
              "mcp__ledger__",
              "Agent("
            ]
          },
          "fragment": "operational-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "body-level mapping from canonical operational tokens to callable host tools",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "Agent(",
              "dispatch_agent("
            ],
            "pi": [
              "Agent("
            ]
          },
          "fragment": "subagent-dispatch",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "subagent dispatch instructions and host transport branch",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent("
            ],
            "codex": [
              "Agent(",
              "dispatch_agent("
            ],
            "pi": [
              "Agent("
            ]
          },
          "fragment": "implement-dispatch-workflow",
          "intentionalDifference": {
            "kind": "dispatch-protocol",
            "reason": "Claude uses the ref-first attested bridge while Codex and Pi retain their catalog-validator dispatch path until their own cutover.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "implement worker, reviewer, and conflict-resolver catalog dispatch procedure",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "workset-effect-discipline",
          "sourceBlock": "shared workset membership, admission, and effect-boundary discipline",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "dispatch-protocol",
          "reason": "Claude uses the ref-first attested bridge while Codex and Pi retain their catalog-validator dispatch path until their own cutover.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:implement:advance",
      "roleId": "implement/advance",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/plan-review.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:plan-review",
      "roleId": "plan-review",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/implement-review.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:implement-review",
      "roleId": "implement-review",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/planners.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:planners",
      "roleId": "planners",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/reviewers.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:reviewers",
      "roleId": "reviewers",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "canonicalSource": "commands/cq/upstream.md",
      "dispatchRelations": [],
      "fragmentBindings": [
        {
          "forbiddenVocabulary": {
            "claude": [
              "$cq-"
            ],
            "codex": [
              "/cq:"
            ],
            "pi": [
              "$cq-"
            ]
          },
          "fragment": "cq-command-invocation",
          "intentionalDifference": {
            "kind": "invocation-syntax",
            "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter and body CQ command references",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [
              "dispatch_agent(",
              "$cq-"
            ],
            "codex": [
              "allowed-tools:",
              "disallowedTools:",
              "mcp__ledger__",
              "Agent"
            ],
            "pi": [
              "Agent",
              "$cq-"
            ]
          },
          "fragment": "host-tool-vocabulary",
          "intentionalDifference": {
            "kind": "tool-vocabulary",
            "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
            "surfaces": [
              "claude",
              "codex",
              "pi"
            ]
          },
          "sourceBlock": "frontmatter host tool and isolation capabilities",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "forbiddenVocabulary": {
            "claude": [],
            "codex": [],
            "pi": []
          },
          "fragment": "ledger-response-contract",
          "sourceBlock": "ledger item-read projection and mutation response contract",
          "supportedSurfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "intentionalDifferences": [
        {
          "kind": "invocation-syntax",
          "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        },
        {
          "kind": "tool-vocabulary",
          "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
          "surfaces": [
            "claude",
            "codex",
            "pi"
          ]
        }
      ],
      "name": "/cq:upstream",
      "roleId": "upstream",
      "roleKind": "orchestrator-command",
      "sharedSourceBlock": {
        "classification": "shared-prose",
        "sourceBlock": "all prose outside the classified surface-sensitive blocks",
        "targetFragment": null
      },
      "sidecar": null,
      "surfaces": [
        "claude",
        "codex",
        "pi"
      ]
    }
  ],
  "catalogMetadataHash": "7f9d3b0a2866083f0ed5ca6db92dd31dea78cd261c5018fd1dd203cbc3832c85",
  "fragmentContracts": [
    {
      "forbiddenVocabulary": {
        "claude": [
          "$cq-"
        ],
        "codex": [
          "/cq:"
        ],
        "pi": [
          "$cq-"
        ]
      },
      "fragment": "cq-command-invocation",
      "intentionalDifference": {
        "kind": "invocation-syntax",
        "reason": "Claude and Pi invoke CQ slash commands while Codex invokes generated CQ skills.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [
          "dispatch_agent("
        ],
        "codex": [
          "Agent(",
          "dispatch_agent("
        ],
        "pi": [
          "Agent("
        ]
      },
      "fragment": "subagent-dispatch",
      "intentionalDifference": {
        "kind": "dispatch-protocol",
        "reason": "Each host exposes a distinct subagent-dispatch transport and argument vocabulary.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [
          "dispatch_agent("
        ],
        "codex": [
          "Agent(",
          "dispatch_agent("
        ],
        "pi": [
          "Agent("
        ]
      },
      "fragment": "implement-dispatch-workflow",
      "intentionalDifference": {
        "kind": "dispatch-protocol",
        "reason": "Claude uses the ref-first attested bridge while Codex and Pi retain their catalog-validator dispatch path until their own cutover.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [
          "input delivered via dispatch prompt"
        ],
        "codex": [
          "input delivered via dispatch prompt"
        ],
        "pi": [
          "fetch_dispatch_input",
          "inputCapability",
          "prepare_dispatch"
        ]
      },
      "fragment": "dispatch-input-delivery",
      "intentionalDifference": {
        "kind": "dispatch-protocol",
        "reason": "Claude and Codex retrieve prepare-bound worker input through the one-shot capability, while Pi retains its held direct-prompt protocol until the coordinated extension migration.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [
          "store_result"
        ],
        "codex": [
          "fenced object",
          "final content"
        ],
        "pi": [
          "store_result"
        ]
      },
      "fragment": "dispatch-result-delivery",
      "intentionalDifference": {
        "kind": "dispatch-protocol",
        "reason": "Codex uses the prepared result capability and handle-only completion while Claude and Pi retain their native structured-result transport.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [
          "fetch_prompt(",
          "$cq-"
        ],
        "codex": [
          "/cq:",
          "fetch_prompt("
        ],
        "pi": [
          "$cq-"
        ]
      },
      "fragment": "inline-command-recursion",
      "intentionalDifference": {
        "kind": "recursion-protocol",
        "reason": "Claude chains native commands, Codex follows skill references, and Pi loads nested prompts through fetch_prompt.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [],
        "codex": [
          "cq-advance-active-"
        ],
        "pi": [
          "cq-advance-active-"
        ]
      },
      "fragment": "advance-run-guard",
      "intentionalDifference": {
        "kind": "tool-vocabulary",
        "reason": "Only the host with the CQ stop hook requires a session sentinel.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [
          "dispatch_agent(",
          "$cq-"
        ],
        "codex": [
          "allowed-tools:",
          "disallowedTools:",
          "mcp__ledger__",
          "Agent"
        ],
        "pi": [
          "Agent",
          "$cq-"
        ]
      },
      "fragment": "host-tool-vocabulary",
      "intentionalDifference": {
        "kind": "tool-vocabulary",
        "reason": "Claude frontmatter, Codex skills, and Pi extensions expose different tool names and capability declarations.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [],
        "codex": [
          "command execution",
          "execute commands"
        ],
        "pi": []
      },
      "fragment": "explorer-static-inspection",
      "intentionalDifference": {
        "kind": "tool-vocabulary",
        "reason": "Codex explorers need a static shell fallback when the harness exposes no dedicated filesystem reader, while Claude and Pi keep shell access disabled.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [
          "dispatch_agent("
        ],
        "codex": [
          "mcp__ledger__",
          "Agent("
        ],
        "pi": [
          "mcp__ledger__",
          "Agent("
        ]
      },
      "fragment": "operational-tool-vocabulary",
      "intentionalDifference": {
        "kind": "tool-vocabulary",
        "reason": "Claude exposes ledger MCP calls through server-qualified names while Codex and Pi expose the callable tool names directly.",
        "surfaces": [
          "claude",
          "codex",
          "pi"
        ]
      },
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [],
        "codex": [],
        "pi": []
      },
      "fragment": "ledger-response-contract",
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    },
    {
      "forbiddenVocabulary": {
        "claude": [],
        "codex": [],
        "pi": []
      },
      "fragment": "workset-effect-discipline",
      "supportedSurfaces": [
        "claude",
        "codex",
        "pi"
      ]
    }
  ],
  "schemaVersion": 1
} as const;
