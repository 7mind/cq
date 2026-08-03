/**
 * GENERATED catalogue — DO NOT EDIT BY HAND (T276, goal G34).
 *
 * Emitted by `packages/ledger-web/scripts/gen-agents-catalogue.ts` from the
 * `cq-assets` agent/command markdown. Regenerate with `bun run gen-agents`
 * (from `nix/pkg/cq-ledgers/`) whenever a role asset's frontmatter or
 * `## Catalogue` block changes.
 *
 * ## WHY this module is COMMITTED rather than built in the sandbox
 * `cq-assets` is OUTSIDE the ledger-web Nix closure: ledger-web's Nix build is a
 * startup `Bun.build` over `src/` only, with no access to the sibling `cq-assets`
 * package or the repo-root `cq.toml.example`. The codegen runs at DEV time, never
 * in the sandbox, so its output is committed into `src/` and bundled like any
 * hand-authored source. Consumers import `AGENT_ROLES` from `./agentsCatalogue.js`
 * (the node-free re-export), never this `.gen` module directly.
 */

import type { AgentRole } from "./agentsCatalogue.js";

export const AGENT_ROLES: AgentRole[] = [
  {
    id: "plan-advance",
    name: "plan-advance",
    kind: "agent-subagent",
    source: "agents/plan-advance.md",
    description: "Read-only plan-flow planner. In default mode returns one PlanStepResult; in explicitly requested candidate mode returns a complete candidate task DAG. Never mutates the ledger or spawns subagents.",
    inputs: [
  "goal id",
  "full goal, answered questions, latest review, current draft, and repository context",
  "explicit candidate-mode request when participating in a planner panel"
],
    outputs: [
  "default: one schema-valid PlanStepResult object",
  "candidate: one schema-valid candidate DAG object"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "no ledger writes in either mode"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"goal id\"\n  - \"full goal, answered questions, latest review, current draft, and repository context\"\n  - \"explicit candidate-mode request when participating in a planner panel\"\noutputs:\n  - \"default: one schema-valid PlanStepResult object\"\n  - \"candidate: one schema-valid candidate DAG object\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"no ledger writes in either mode\"\n```\n\nYou plan one goal. Read the ledger and repository without mutating domain\nledgers, and never spawn a child. Produce exactly one structured object matching\nthe selected mode.\n\n## Read state\n\nFetch the goal with full projection. From its coordination milestone, read\ngoal-linked questions and reviews with full projection. Choose the latest\nreview by id ordering. Read `planCurrentDraft` when revising. Incorporate all\nanswered questions and existing grounding.\n\nTriage unknowns by who can answer them:\n\n- a verifiable fact belongs in a `researches` action;\n- a requirements, scope, policy, or preference choice belongs in a `questions`\n  action;\n- discoverable repository facts are your responsibility.\n\nIf both types block planning, ask the requirements questions first.\n\n## Default mode\n\nUse default mode unless the dispatch explicitly requests candidate mode. The\norchestrator already owns a guarded planning claim. Return one state-derived\naction and perform no mutation.\n\n```json\n{\n  \"mode\": \"default\",\n  \"action\": \"questions | researches | draft | finalize | awaiting | noop\",\n  \"grounding\": \"<optional repository findings>\",\n  \"questions\": [\n    {\n      \"key\": \"<stable slug>\",\n      \"question\": \"<blocking user choice>\",\n      \"context\": \"<why it blocks>\",\n      \"suggestions\": [\"<option>\"],\n      \"recommendation\": \"<recommended option>\"\n    }\n  ],\n  \"researches\": [\n    {\n      \"key\": \"<stable slug>\",\n      \"question\": \"<empirical question>\",\n      \"scope\": \"<bounded investigation>\"\n    }\n  ],\n  \"manifest\": {\n    \"milestones\": [\n      {\n        \"key\": \"<stable slug>\",\n        \"title\": \"<work milestone>\",\n        \"description\": \"<optional>\",\n        \"dependsOn\": [\n          { \"kind\": \"draft-milestone\", \"key\": \"<milestone key>\" }\n        ]\n      }\n    ],\n    \"tasks\": [\n      {\n        \"key\": \"<stable slug>\",\n        \"milestoneKey\": \"<milestone key>\",\n        \"headline\": \"<imperative task>\",\n        \"description\": \"<implementation scope>\",\n        \"acceptance\": \"<observable verification>\",\n        \"suggestedModel\": \"frontier | standard | fast\",\n        \"ledgerRefs\": [\"goals:<G>\", \"defects:<D>\"],\n        \"sourceRefs\": [\"<provenance ref>\"],\n        \"dependsOn\": [\n          { \"kind\": \"draft-task\", \"key\": \"<task key>\" },\n          { \"kind\": \"ledger\", \"ref\": \"<ledger>:<id>\" }\n        ]\n      }\n    ]\n  },\n  \"finalize\": {\n    \"reviewId\": \"<review id>\",\n    \"decision\": {\n      \"headline\": \"plan review: approved\",\n      \"rationale\": \"<why this review authorizes finalization>\"\n    }\n  },\n  \"defectsToFile\": {\n    \"reviewId\": \"<review id>\",\n    \"defects\": [\n      {\n        \"key\": \"<stable slug>\",\n        \"headline\": \"<fault>\",\n        \"severity\": \"low | medium | high | critical\",\n        \"description\": \"<optional>\",\n        \"rootCause\": \"<optional>\",\n        \"suggestedFix\": \"<optional>\"\n      }\n    ]\n  }\n}\n```\n\nEmit only fields allowed by the selected action:\n\n- `questions`: one or more user-only questions.\n- `researches`: one or more empirical investigations.\n- `draft`: a complete `manifest`; revisions replace the prior draft, so retain\n  every still-valid entry.\n- `finalize`: the latest `go-ahead` review id and a decision.\n- `awaiting`: an open linked question already exists; no payload.\n- `noop`: nothing applies; no payload.\n\n`grounding` and `defectsToFile` remain optional where the schema permits.\nEvery manifest needs at least one milestone and task. Use stable client keys.\nDraft references target keys in the same manifest; ledger references target\nalready persisted items. A research-gated task may depend on a research only\nafter that research exists. Set every task's model tier:\n\n- `frontier` for ambiguous, architectural, or cross-cutting work;\n- `standard` for ordinary nontrivial implementation;\n- `fast` for trivial mechanical work.\n\nAcceptance must name a command, observable result, or invariant. Every task\ndeclares its owning `goals:<G>` reference in `ledgerRefs`. Defect-fix tasks\ncarry their defect ownership in `ledgerRefs`; `sourceRefs` records provenance only.\n\n### Choosing the action\n\nUse the first applicable rule:\n\n1. An open linked question exists → `awaiting`.\n2. Missing user choices prevent planning → `questions`.\n3. Only empirical unknowns prevent planning → `researches`.\n4. No unconsumed review and enough context exists → `draft`.\n5. Latest review is `revise` with questions → `questions`.\n6. Latest review is `revise` with criticism only → return a complete revised\n   `draft`.\n7. Latest review is `go-ahead` → `finalize`.\n8. Otherwise → `noop`.\n\nA defect-seeded goal whose description contains the confirmed cause and\nsuggested correction normally needs no clarification; plan the fix directly.\nNever close a goal.\n\n### Review defects\n\nWhen acting on a review, its `defects[]` contains either canonical serialized\ndefect objects or receipts proving the batch was already filed.\n\n- If any receipt exists, omit `defectsToFile`.\n- Otherwise parse the entire batch. Require exact fields, canonical\n  serialization, a non-empty headline, and a valid severity. One invalid entry\n  invalidates the whole batch.\n- For a valid unfiled batch, return `defectsToFile` with that review id and\n  stable client keys.\n\nThese defects remain orthogonal to the review verdict and are handled by the\norchestrator.\n\n## Candidate mode\n\nEnter candidate mode only when explicitly requested as one member of a planner\npanel. Propose a complete DAG; do not emit a PlanStepResult or mutate state. If\nthe goal still needs clarification, return empty arrays and explain why in\n`rationale`.\n\n```json\n{\n  \"mode\": \"candidate\",\n  \"milestones\": [\n    {\n      \"title\": \"<work milestone>\",\n      \"dependsOn\": [\"<other milestone title>\"]\n    }\n  ],\n  \"tasks\": [\n    {\n      \"headline\": \"<imperative task>\",\n      \"description\": \"<implementation scope>\",\n      \"acceptance\": \"<observable verification>\",\n      \"suggestedModel\": \"standard\",\n      \"milestone\": \"<milestone title>\",\n      \"dependsOn\": [\"<other task headline>\", \"<persisted ledger ref>\"],\n      \"ledgerRefs\": [\"goals:<G>\", \"defects:<D>\"]\n    }\n  ],\n  \"rationale\": \"<decomposition and sequencing rationale>\"\n}\n```\n\nReferences to candidate milestones/tasks use their titles/headlines because ids\ndo not exist yet. Persisted ledger references remain literal. Do not invent\nextra fields.\n\n## Output\n\nThe result object must cover the decision, evidence, and blockers. The\norchestrator validates and persists it; do not mutate domain ledgers.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RO",
    exposedTools: "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Bash",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/plan-advance/input",
      "title": "plan-advance input",
      "type": "object",
      "properties": {
        "goalId": {
          "type": "string",
          "description": "The goal id G passed in the dispatch prompt (e.g. G41).",
          "pattern": "^G[0-9]+$"
        },
        "candidateMode": {
          "type": "boolean",
          "description": "True iff the orchestrator dispatched this planner in CANDIDATE mode (one of N parallel candidate planners under generate-N-then-judge). Absent/false ⇒ DEFAULT single-planner mode."
        }
      },
      "required": [
        "goalId"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/plan-advance/output",
      "title": "plan-advance output",
      "oneOf": [
        {
          "title": "DEFAULT-mode PlanStepResult",
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "default"
              ]
            },
            "action": {
              "type": "string",
              "enum": [
                "questions",
                "researches",
                "draft",
                "finalize",
                "awaiting",
                "noop"
              ]
            },
            "grounding": {
              "type": "string"
            },
            "questions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string",
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "question": {
                    "type": "string",
                    "minLength": 1
                  },
                  "context": {
                    "type": "string"
                  },
                  "suggestions": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "recommendation": {
                    "type": "string"
                  }
                },
                "required": [
                  "key",
                  "question"
                ],
                "additionalProperties": false
              },
              "minItems": 1
            },
            "researches": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string",
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "question": {
                    "type": "string",
                    "minLength": 1
                  },
                  "scope": {
                    "type": "string"
                  }
                },
                "required": [
                  "key",
                  "question"
                ],
                "additionalProperties": false
              },
              "minItems": 1
            },
            "manifest": {
              "type": "object",
              "properties": {
                "milestones": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string",
                        "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                      },
                      "title": {
                        "type": "string",
                        "minLength": 1
                      },
                      "description": {
                        "type": "string"
                      },
                      "dependsOn": {
                        "type": "array",
                        "items": {
                          "oneOf": [
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "draft-milestone"
                                  ]
                                },
                                "key": {
                                  "type": "string",
                                  "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                                }
                              },
                              "required": [
                                "kind",
                                "key"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "draft-task"
                                  ]
                                },
                                "key": {
                                  "type": "string",
                                  "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                                }
                              },
                              "required": [
                                "kind",
                                "key"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "ledger"
                                  ]
                                },
                                "ref": {
                                  "type": "string",
                                  "minLength": 1
                                }
                              },
                              "required": [
                                "kind",
                                "ref"
                              ],
                              "additionalProperties": false
                            }
                          ]
                        }
                      },
                      "blockedBy": {
                        "type": "array",
                        "items": {
                          "oneOf": [
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "draft-milestone"
                                  ]
                                },
                                "key": {
                                  "type": "string",
                                  "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                                }
                              },
                              "required": [
                                "kind",
                                "key"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "draft-task"
                                  ]
                                },
                                "key": {
                                  "type": "string",
                                  "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                                }
                              },
                              "required": [
                                "kind",
                                "key"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "ledger"
                                  ]
                                },
                                "ref": {
                                  "type": "string",
                                  "minLength": 1
                                }
                              },
                              "required": [
                                "kind",
                                "ref"
                              ],
                              "additionalProperties": false
                            }
                          ]
                        }
                      }
                    },
                    "required": [
                      "key",
                      "title"
                    ],
                    "additionalProperties": false
                  },
                  "minItems": 1
                },
                "tasks": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string",
                        "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                      },
                      "milestoneKey": {
                        "type": "string",
                        "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                      },
                      "headline": {
                        "type": "string",
                        "minLength": 1
                      },
                      "description": {
                        "type": "string"
                      },
                      "acceptance": {
                        "type": "string"
                      },
                      "suggestedModel": {
                        "type": "string",
                        "enum": [
                          "frontier",
                          "standard",
                          "fast"
                        ]
                      },
                      "ledgerRefs": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1
                        },
                        "minItems": 1
                      },
                      "sourceRefs": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "tags": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "dependsOn": {
                        "type": "array",
                        "items": {
                          "oneOf": [
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "draft-milestone"
                                  ]
                                },
                                "key": {
                                  "type": "string",
                                  "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                                }
                              },
                              "required": [
                                "kind",
                                "key"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "draft-task"
                                  ]
                                },
                                "key": {
                                  "type": "string",
                                  "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                                }
                              },
                              "required": [
                                "kind",
                                "key"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "ledger"
                                  ]
                                },
                                "ref": {
                                  "type": "string",
                                  "minLength": 1
                                }
                              },
                              "required": [
                                "kind",
                                "ref"
                              ],
                              "additionalProperties": false
                            }
                          ]
                        }
                      },
                      "blockedBy": {
                        "type": "array",
                        "items": {
                          "oneOf": [
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "draft-milestone"
                                  ]
                                },
                                "key": {
                                  "type": "string",
                                  "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                                }
                              },
                              "required": [
                                "kind",
                                "key"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "draft-task"
                                  ]
                                },
                                "key": {
                                  "type": "string",
                                  "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                                }
                              },
                              "required": [
                                "kind",
                                "key"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "enum": [
                                    "ledger"
                                  ]
                                },
                                "ref": {
                                  "type": "string",
                                  "minLength": 1
                                }
                              },
                              "required": [
                                "kind",
                                "ref"
                              ],
                              "additionalProperties": false
                            }
                          ]
                        }
                      }
                    },
                    "required": [
                      "key",
                      "milestoneKey",
                      "headline",
                      "ledgerRefs"
                    ],
                    "additionalProperties": false
                  },
                  "minItems": 1
                }
              },
              "required": [
                "milestones",
                "tasks"
              ],
              "additionalProperties": false
            },
            "finalize": {
              "type": "object",
              "properties": {
                "reviewId": {
                  "type": "string",
                  "pattern": "^R[0-9]+$"
                },
                "decision": {
                  "type": "object",
                  "properties": {
                    "headline": {
                      "type": "string",
                      "minLength": 1
                    },
                    "rationale": {
                      "type": "string"
                    },
                    "alternatives": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "headline"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "reviewId",
                "decision"
              ],
              "additionalProperties": false
            },
            "defectsToFile": {
              "type": "object",
              "properties": {
                "reviewId": {
                  "type": "string",
                  "pattern": "^R[0-9]+$"
                },
                "defects": {
                  "type": "array",
                  "minItems": 1,
                  "items": {
                    "type": "object",
                    "properties": {
                      "key": {
                        "type": "string",
                        "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                      },
                      "headline": {
                        "type": "string",
                        "minLength": 1
                      },
                      "severity": {
                        "type": "string",
                        "enum": [
                          "low",
                          "medium",
                          "high",
                          "critical"
                        ]
                      },
                      "description": {
                        "type": "string"
                      },
                      "rootCause": {
                        "type": "string"
                      },
                      "suggestedFix": {
                        "type": "string"
                      },
                      "sourceRefs": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "tags": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      }
                    },
                    "required": [
                      "key",
                      "headline",
                      "severity"
                    ],
                    "additionalProperties": false
                  }
                }
              },
              "required": [
                "reviewId",
                "defects"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "mode",
            "action"
          ],
          "additionalProperties": false,
          "allOf": [
            {
              "if": {
                "properties": {
                  "action": {
                    "const": "questions"
                  }
                },
                "required": [
                  "action"
                ]
              },
              "then": {
                "required": [
                  "questions"
                ],
                "not": {
                  "anyOf": [
                    {
                      "required": [
                        "researches"
                      ]
                    },
                    {
                      "required": [
                        "manifest"
                      ]
                    },
                    {
                      "required": [
                        "finalize"
                      ]
                    }
                  ]
                }
              }
            },
            {
              "if": {
                "properties": {
                  "action": {
                    "const": "researches"
                  }
                },
                "required": [
                  "action"
                ]
              },
              "then": {
                "required": [
                  "researches"
                ],
                "not": {
                  "anyOf": [
                    {
                      "required": [
                        "questions"
                      ]
                    },
                    {
                      "required": [
                        "manifest"
                      ]
                    },
                    {
                      "required": [
                        "finalize"
                      ]
                    }
                  ]
                }
              }
            },
            {
              "if": {
                "properties": {
                  "action": {
                    "const": "draft"
                  }
                },
                "required": [
                  "action"
                ]
              },
              "then": {
                "required": [
                  "manifest"
                ],
                "not": {
                  "anyOf": [
                    {
                      "required": [
                        "questions"
                      ]
                    },
                    {
                      "required": [
                        "researches"
                      ]
                    },
                    {
                      "required": [
                        "finalize"
                      ]
                    }
                  ]
                }
              }
            },
            {
              "if": {
                "properties": {
                  "action": {
                    "const": "finalize"
                  }
                },
                "required": [
                  "action"
                ]
              },
              "then": {
                "required": [
                  "finalize"
                ],
                "not": {
                  "anyOf": [
                    {
                      "required": [
                        "questions"
                      ]
                    },
                    {
                      "required": [
                        "researches"
                      ]
                    },
                    {
                      "required": [
                        "manifest"
                      ]
                    }
                  ]
                }
              }
            },
            {
              "if": {
                "properties": {
                  "action": {
                    "const": "awaiting"
                  }
                },
                "required": [
                  "action"
                ]
              },
              "then": {
                "not": {
                  "anyOf": [
                    {
                      "required": [
                        "questions"
                      ]
                    },
                    {
                      "required": [
                        "researches"
                      ]
                    },
                    {
                      "required": [
                        "manifest"
                      ]
                    },
                    {
                      "required": [
                        "finalize"
                      ]
                    }
                  ]
                }
              }
            },
            {
              "if": {
                "properties": {
                  "action": {
                    "const": "noop"
                  }
                },
                "required": [
                  "action"
                ]
              },
              "then": {
                "not": {
                  "anyOf": [
                    {
                      "required": [
                        "questions"
                      ]
                    },
                    {
                      "required": [
                        "researches"
                      ]
                    },
                    {
                      "required": [
                        "manifest"
                      ]
                    },
                    {
                      "required": [
                        "finalize"
                      ]
                    }
                  ]
                }
              }
            }
          ]
        },
        {
          "title": "CANDIDATE-mode task-DAG",
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "candidate"
              ]
            },
            "milestones": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "title": {
                    "type": "string",
                    "minLength": 1
                  },
                  "dependsOn": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                },
                "required": [
                  "title"
                ],
                "additionalProperties": false
              }
            },
            "tasks": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "headline": {
                    "type": "string",
                    "minLength": 1
                  },
                  "description": {
                    "type": "string"
                  },
                  "acceptance": {
                    "type": "string"
                  },
                  "suggestedModel": {
                    "type": "string",
                    "enum": [
                      "frontier",
                      "standard",
                      "fast"
                    ]
                  },
                  "milestone": {
                    "type": "string",
                    "minLength": 1
                  },
                  "dependsOn": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "ledgerRefs": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1
                    },
                    "minItems": 1
                  }
                },
                "required": [
                  "headline",
                  "acceptance",
                  "suggestedModel",
                  "milestone",
                  "ledgerRefs"
                ],
                "additionalProperties": false
              }
            },
            "rationale": {
              "type": "string"
            }
          },
          "required": [
            "mode",
            "milestones",
            "tasks",
            "rationale"
          ],
          "additionalProperties": false
        }
      ]
    },
  },
  {
    id: "plan-reviewer",
    name: "plan-reviewer",
    kind: "agent-subagent",
    source: "agents/plan-reviewer.md",
    description: "Adversarial plan reviewer. Returns a structured go-ahead/revise verdict; writes one review only in unconfigured single-reviewer mode.",
    inputs: [
  "goal, full answered-question history, grounding, current draft, and prior reviews"
],
    outputs: [
  "structured verdict; in fallback mode, one matching review item"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "go-ahead requires empty question/criticism buckets; revise requires at least one"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"goal, full answered-question history, grounding, current draft, and prior reviews\"\noutputs:\n  - \"structured verdict; in fallback mode, one matching review item\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"go-ahead requires empty question/criticism buckets; revise requires at least one\"\n```\n\nReview the complete current plan against the goal, all answered questions, and\nthe actual repository. Apply the shared plan-review rubric. Check scope,\ngrounding, task granularity, dependency order, concrete acceptance, model tiers,\nand completeness.\n\nClassify findings:\n\n- `new_questions`: user-only requirements or preferences;\n- `criticism`: plan defects the planner can correct;\n- `defects`: out-of-scope or pre-existing faults, independent of verdict.\n\nDo not turn discoverable facts or fix-disposition choices into questions.\n\n```json\n{\n  \"summary\": \"<one-line verdict>\",\n  \"verdict\": \"revise\",\n  \"new_questions\": [\"<user-only question>\"],\n  \"criticism\": [\"<planner-fixable defect>\"],\n  \"defects\": [\n    {\n      \"headline\": \"<fault>\",\n      \"severity\": \"medium\",\n      \"rootCause\": \"<optional>\",\n      \"suggestedFix\": \"<optional>\"\n    }\n  ]\n}\n```\n\n`go-ahead` requires empty `new_questions` and `criticism`; `revise` requires at\nleast one. `defects` never controls the verdict.\n\nIn configured panel mode, return the verdict without creating a review item. In\nunconfigured single-reviewer mode, write exactly one goal-linked `reviews`\nitem with the verdict status and buckets, then return the identical structured\nobject. Persist each defect as compact canonical JSON with property order\n`headline`, `severity`, optional `rootCause`, optional `suggestedFix`; keep the\nreturned objects structured. Never return a review-id pointer instead of the\nobject.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RO",
    exposedTools: "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Bash",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/plan-reviewer/input",
      "title": "plan-reviewer input",
      "type": "object",
      "properties": {
        "goalId": {
          "type": "string",
          "description": "The goal id G passed in the dispatch prompt (e.g. G41).",
          "pattern": "^G[0-9]+$"
        }
      },
      "required": [
        "goalId"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/plan-reviewer/output",
      "title": "plan-reviewer verdict",
      "type": "object",
      "properties": {
        "summary": {
          "type": "string"
        },
        "verdict": {
          "type": "string",
          "enum": [
            "go-ahead",
            "revise"
          ]
        },
        "new_questions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "criticism": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "defects": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "headline": {
                "type": "string",
                "minLength": 1
              },
              "severity": {
                "type": "string",
                "enum": [
                  "low",
                  "medium",
                  "high",
                  "critical"
                ]
              },
              "rootCause": {
                "type": "string"
              },
              "suggestedFix": {
                "type": "string"
              }
            },
            "required": [
              "headline",
              "severity"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "summary",
        "verdict",
        "new_questions",
        "criticism",
        "defects"
      ],
      "additionalProperties": false
    },
  },
  {
    id: "implement-worker",
    name: "implement-worker",
    kind: "agent-subagent",
    source: "agents/implement-worker.md",
    description: "Implement exactly one task in an isolated worktree, prove its guards and full gate, commit it, and store a structured result.",
    inputs: [
  "task specification, isolated worktree/branch, verified base, round, authoritative starting commit, optional prior criticism"
],
    outputs: [
  "one verified task commit, stored structured result, and handle-only final reply"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "pass requires a green full gate, verified commit/clean tree/ancestry, and required mutation evidence"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n\n```yaml\ninputs:\n  - \"task specification, isolated worktree/branch, verified base, round, authoritative starting commit, optional prior criticism\"\noutputs:\n  - \"one verified task commit, stored structured result, and handle-only final reply\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"pass requires a green full gate, verified commit/clean tree/ancestry, and required mutation evidence\"\n```\n\nImplement exactly one task. Never mutate the ledger, merge, push, rebase, or\nspawn a child. Work only inside the supplied worktree and task branch. Do not\noperate on another checkout or alter its refs. Report a stale or unusable base\ninstead of improvising cross-checkout repair.\n\n### Dispatch input delivery (Claude)\n\nThe launch prompt carries only\n`{ attestationId, generation, inputCapability }`. Before reading or changing\nthe repository, call the ledger MCP `fetch_dispatch_input` tool exactly once\nwith those three fields. Treat its returned `input` as the task specification\ndescribed below. A missing capability, failed retrieval, or second retrieval is\na protocol failure: stop and return `status: \"fail\"` rather than reading task\nnarrative from the ledger or improvising it from the compact launch reference.\n\n\nTreat the resolved task headline, description, and acceptance as the\nspecification. Address every supplied prior criticism.\n\n## Procedure\n\n1. **Verify the base before other work.**\n   Require `git rev-parse HEAD` to equal `startingCommit`, then require\n   `git merge-base --is-ancestor <baseCommit> HEAD` to exit zero. These checks\n   apply to every initial and criticism round. Report `fail` if either check\n   cannot be satisfied; never reset away prior task commits.\n\n2. **Install dependencies when needed.** A fresh worktree has no\n   `node_modules`; run the workspace install. Never reuse another checkout via\n   symlink. Force a proper install when the existing layout is incomplete.\n\n3. **Implement surgically.** Reproduce a defect before correcting it. Match\n   project conventions and do not repair unrelated faults.\n\n4. **Prove changed guards.** For every test, assertion, guard, or invariant you\n   add or change, deliberately make it fail, capture the expected failure,\n   restore the intended bytes, and capture the pass. Hash affected files before\n   mutation and after restoration. Report only observations from this run in\n   `mutationTable`; if evidence is unavailable, report the gap rather than\n   claiming success.\n\n5. **Run targeted checks.** Use exact test paths when discovery matters and\n   record nonzero test counts. Check wrapped prose with a multiline-aware\n   operation.\n\n6. **Run the full gate in the foreground.** From the worktree root, run exactly\n   `cq gate run --worktree \"$PWD\" --command-cwd \"$PWD/nix/pkg/cq-ledgers\" -- bun run check`.\n   A yielded command-session handle remains the sole full-gate attempt. Continue\n   to poll that exact session or explicitly terminate it; after termination,\n   continue polling and require terminal settlement before retrying the gate,\n   calling `store_result`, or returning. Never launch a replacement full-gate\n   attempt while the prior session remains live.\n   Capture start/end time and assign its exit status\n   immediately after the command, independent of any pipe or wrapper. Preserve\n   `REAL_CHECK_EXIT=<n>`, the verbatim result tail, and `gateDurationMs`.\n   Iterate until zero. An unrelated-failure claim requires an A/B reproduction\n   of the same selector and signature on this tree and the recorded base; if\n   confinement prevents that proof, return `fail`.\n\n7. **Commit and verify.** Commit all task changes, then require:\n   - `git rev-parse --verify HEAD` succeeds;\n   - `git cat-file -t <head>` returns `commit`;\n   - `git status --porcelain --untracked-files=all` is empty;\n   - `git merge-base --is-ancestor <baseCommit> HEAD` exits zero.\n     Immediately before constructing the result, rerun\n     `git rev-parse --verify HEAD` and copy its stdout verbatim into\n     `resultCommit`, then require\n     `git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.\n\n## Result\n\n```json\n{\n  \"taskId\": \"<task id>\",\n  \"status\": \"pass | fail\",\n  \"resultCommit\": \"<verified head, or null on fail>\",\n  \"branch\": \"implement/<taskId>\",\n  \"filesTouched\": [\"<path>\"],\n  \"checkSummary\": \"<REAL_CHECK_EXIT plus verbatim result tail or failure>\",\n  \"gateDurationMs\": 0,\n  \"summary\": \"<what changed, how acceptance was met, and residual risk>\",\n  \"blockedReason\": \"<fail only>\"\n}\n```\n\nThe prompt-catalog schema is authoritative, including any conditional\n`mutationTable` requirement. `pass` requires observed gate success, mutation\nevidence where required, a verified commit object, a clean tree, and base\nancestry.\n\nStore the object exactly once through the dispatch-scoped `store_result` tool. Only a\n`result-stored` acknowledgement permits the final response. Then reply with the\nprepared dispatch handle only as the exact one-line JSON\n`{\"attestationId\":\"<prepared attestation id>\",\"generation\":<prepared generation>}`\nand nothing else; never return the result body or a capability.",
    privilege: "RW",
    exposedTools: "Disallowed: Agent; isolation: worktree",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/implement-worker/input",
      "title": "implement-worker input",
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string",
          "description": "The task id T passed in the dispatch prompt (e.g. T341).",
          "pattern": "^T[0-9]+$"
        },
        "headline": {
          "type": "string",
          "minLength": 1
        },
        "description": {
          "type": "string"
        },
        "acceptance": {
          "type": "string",
          "minLength": 1
        },
        "worktreePath": {
          "type": "string",
          "minLength": 1
        },
        "branch": {
          "type": "string",
          "description": "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
          "pattern": "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$"
        },
        "baseCommit": {
          "type": "string",
          "description": "The commit the worktree was cut from (full or abbreviated sha).",
          "minLength": 1
        },
        "round": {
          "type": "integer",
          "description": "The zero-based implementation or correction round.",
          "minimum": 0
        },
        "startingCommit": {
          "type": "string",
          "description": "The authoritative worktree tip immediately before this round launches.",
          "pattern": "^[0-9a-f]{40}$"
        },
        "priorCriticism": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Prior-round reviewer criticism[] on a re-dispatch after review."
        },
        "resolvedModel": {
          "type": "string",
          "description": "The resolved model class (informational)."
        }
      },
      "required": [
        "taskId",
        "acceptance",
        "worktreePath",
        "branch",
        "baseCommit",
        "round",
        "startingCommit"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/implement-worker/output",
      "title": "implement-worker result",
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string",
          "pattern": "^T[0-9]+$"
        },
        "status": {
          "type": "string",
          "enum": [
            "pass",
            "fail"
          ]
        },
        "resultCommit": {
          "type": [
            "string",
            "null"
          ],
          "description": "Full 40-hex commit sha on pass (^[0-9a-f]{40}$); null on fail. The pattern applies only to a string instance, so null still validates.",
          "pattern": "^[0-9a-f]{40}$"
        },
        "branch": {
          "type": "string",
          "description": "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
          "pattern": "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$"
        },
        "filesTouched": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "checkSummary": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "blockedReason": {
          "type": "string"
        },
        "gateDurationMs": {
          "type": "integer",
          "minimum": 0,
          "description": "Wall-clock milliseconds `bun run check` took. Required when status is \"pass\"."
        },
        "mutationTable": {
          "type": "array",
          "description": "Evidence rows for a claimed mutation/guard change: one {mutation, observed, restored} triple per test/guard mutated. REQUIRED iff filesTouched intersects TEST_GUARD_GLOBS = ['**/test/**', '**/*.test.ts', '**/*guard*', '**/*invariant*'] — i.e. at least one filesTouched entry is under a test/ directory, ends in .test.ts, or names a guard or invariant. Omit entirely when no touched file matches (do not send an empty array).",
          "items": {
            "type": "object",
            "properties": {
              "mutation": {
                "type": "string"
              },
              "observed": {
                "type": "string"
              },
              "restored": {
                "type": "string"
              }
            },
            "required": [
              "mutation",
              "observed",
              "restored"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "taskId",
        "status",
        "resultCommit",
        "branch",
        "filesTouched",
        "checkSummary",
        "summary"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "const": "pass"
              }
            },
            "required": [
              "status"
            ]
          },
          "then": {
            "required": [
              "gateDurationMs"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "filesTouched": {
                "type": "array",
                "contains": {
                  "type": "string",
                  "pattern": "(?:^(.*/)?test/.*$)|(?:^(.*/)?[^/]*\\.test\\.ts$)|(?:^(.*/)?[^/]*guard[^/]*$)|(?:^(.*/)?[^/]*invariant[^/]*$)"
                }
              }
            },
            "required": [
              "filesTouched"
            ]
          },
          "then": {
            "required": [
              "mutationTable"
            ]
          }
        }
      ]
    },
  },
  {
    id: "implement-reviewer",
    name: "implement-reviewer",
    kind: "agent-subagent",
    source: "agents/implement-reviewer.md",
    description: "Adversarial implementation reviewer that verifies one task and stores a structured approve/disapprove verdict without mutating the ledger.",
    inputs: [
  "task specification, worktree/branch/base, worker result, round, and prior criticism"
],
    outputs: [
  "stored structured verdict and handle-only final reply"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "approve requires empty criticism/questions, green gate, and verified commit"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n### Dispatch input delivery (Claude)\n\nThe launch prompt carries `attestationId`, `generation`, and `inputCapability`.\nBefore reading or changing the repository, call the ledger MCP\n`fetch_dispatch_input` tool exactly once and treat its typed input as the\ncomplete review assignment. A failed or second retrieval is a protocol failure.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"task specification, worktree/branch/base, worker result, round, and prior criticism\"\noutputs:\n  - \"stored structured verdict and handle-only final reply\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"approve requires empty criticism/questions, green gate, and verified commit\"\n```\n\nReview one task against the actual diff and acceptance. Never edit the\nrepository, mutate the ledger, or spawn a child.\n\nRun `git -C <worktree> cat-file -t <resultCommit>` and require `commit`. Run\n`git -C <worktree> rev-parse --verify <branch>` and require its full SHA to\nequal `resultCommit`. When rerunning `bun run check`, use the foreground\nprocess's real exit status and measure its duration. Check acceptance,\ncorrectness, boundary handling, type safety, surgical scope, and defect\nreproduction.\n\nClassify each finding once:\n\n- `criticism`: objective defects the worker can fix;\n- `questions`: unresolved user-only requirements or product choices;\n- `defects`: out-of-scope or pre-existing faults for separate work.\n\nDiscoverable facts, cost, scope magnitude, and whether to fix a confirmed fault\nare not questions.\n\n```json\n{\n  \"taskId\": \"<task id>\",\n  \"verdict\": \"approve | disapprove\",\n  \"criticism\": [\"<worker-fixable defect>\"],\n  \"questions\": [\"<user-only ambiguity>\"],\n  \"defects\": [\n    {\n      \"headline\": \"<out-of-scope fault>\",\n      \"description\": \"<evidence and scope boundary>\",\n      \"severity\": \"low | medium | high | critical\",\n      \"suggestedFix\": \"<optional>\"\n    }\n  ],\n  \"rationale\": \"<decisive evidence>\",\n  \"gateReRan\": true,\n  \"resultCommitVerified\": true,\n  \"gateDurationMs\": 12345,\n  \"summary\": \"<optional one-line verdict>\"\n}\n```\n\nAlways state `gateReRan` and `resultCommitVerified`. Include\n`gateDurationMs` only when the gate ran; otherwise include an optional\n`gateReRanReason`. Approval requires empty criticism/questions, a green gate,\nand verified result commit. Disapproval requires criticism or questions.\nDefects do not control the verdict.\n\nStore the object exactly once through the dispatch-scoped `store_result` tool. Only a\n`result-stored` acknowledgement permits the final response. Then reply with the\nprepared dispatch handle only; never return the verdict body or a capability.",
    privilege: "RO",
    exposedTools: "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Agent",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/implement-reviewer/input",
      "title": "implement-reviewer input",
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string",
          "pattern": "^T[0-9]+$"
        },
        "headline": {
          "type": "string",
          "minLength": 1
        },
        "description": {
          "type": "string"
        },
        "acceptance": {
          "type": "string",
          "minLength": 1
        },
        "worktreePath": {
          "type": "string",
          "minLength": 1
        },
        "branch": {
          "type": "string",
          "description": "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
          "pattern": "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$"
        },
        "baseCommit": {
          "type": "string",
          "minLength": 1
        },
        "workerResult": {
          "type": "object",
          "properties": {
            "resultCommit": {
              "type": [
                "string",
                "null"
              ]
            },
            "checkSummary": {
              "type": "string"
            },
            "filesTouched": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "resultCommit",
            "checkSummary",
            "filesTouched"
          ],
          "additionalProperties": true
        },
        "round": {
          "type": "integer",
          "minimum": 1
        },
        "priorCriticism": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "taskId",
        "acceptance",
        "worktreePath",
        "branch",
        "baseCommit",
        "workerResult",
        "round"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/implement-reviewer/output",
      "title": "implement-reviewer verdict",
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string",
          "pattern": "^T[0-9]+$"
        },
        "verdict": {
          "type": "string",
          "enum": [
            "approve",
            "disapprove"
          ]
        },
        "criticism": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "questions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "defects": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "headline": {
                "type": "string",
                "minLength": 1
              },
              "description": {
                "type": "string",
                "minLength": 1
              },
              "severity": {
                "type": "string",
                "enum": [
                  "low",
                  "medium",
                  "high",
                  "critical"
                ]
              },
              "suggestedFix": {
                "type": "string"
              }
            },
            "required": [
              "headline",
              "description",
              "severity"
            ],
            "additionalProperties": false
          }
        },
        "rationale": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "gateReRan": {
          "type": "boolean",
          "description": "Whether the reviewer re-ran `bun run check` itself rather than trusting the worker's claim."
        },
        "resultCommitVerified": {
          "type": "boolean",
          "description": "Whether the reviewer verified the worker's resultCommit sha (e.g. via cat-file / tip equality) rather than accepting it unchecked."
        },
        "gateDurationMs": {
          "type": "integer",
          "minimum": 0,
          "description": "Wall-clock milliseconds the reviewer's own re-run of `bun run check` took. Required when gateReRan is true."
        },
        "gateReRanReason": {
          "type": "string",
          "description": "Optional free-text explanation for why the gate was not re-run, when gateReRan is false."
        }
      },
      "required": [
        "taskId",
        "verdict",
        "criticism",
        "questions",
        "defects",
        "rationale",
        "gateReRan",
        "resultCommitVerified"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "gateReRan": {
                "const": true
              }
            },
            "required": [
              "gateReRan"
            ]
          },
          "then": {
            "required": [
              "gateDurationMs"
            ]
          }
        }
      ]
    },
  },
  {
    id: "implement-conflict-resolver",
    name: "implement-conflict-resolver",
    kind: "agent-subagent",
    source: "agents/implement-conflict-resolver.md",
    description: "Resolve one rebase conflict in an implementation worktree, preserve both intents, run the full gate, and store a structured result.",
    inputs: [
  "task context, conflicted worktree/branch, base commit, conflicting files, and optional base-side note"
],
    outputs: [
  "stored structured result and handle-only final reply"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "pass requires completed rebase and green full gate"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n### Dispatch input delivery (Claude)\n\nThe launch prompt carries `attestationId`, `generation`, and `inputCapability`.\nBefore reading or changing the repository, call the ledger MCP\n`fetch_dispatch_input` tool exactly once and treat its typed input as the\ncomplete conflict-resolution assignment. A failed or second retrieval is a\nprotocol failure.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"task context, conflicted worktree/branch, base commit, conflicting files, and optional base-side note\"\noutputs:\n  - \"stored structured result and handle-only final reply\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"pass requires completed rebase and green full gate\"\n```\n\nResolve the supplied rebase conflict inside its worktree. Preserve both the\nalready-merged base behavior and the task's intent. Edit only conflict-related\nfiles, continue the rebase, and run `bun run check` in the worktree foreground.\nNever push, mutate the ledger, operate on another checkout, or spawn a child.\n\nIf the intents require task redesign or the gate cannot pass through conflict\nresolution alone, leave the worktree for inspection and return `fail` with a\nprecise reason.\n\n```json\n{\n  \"taskId\": \"<task id>\",\n  \"status\": \"pass | fail\",\n  \"resultCommit\": \"<rebased tip on pass, otherwise null>\",\n  \"filesResolved\": [\"<path>\"],\n  \"checkSummary\": \"<real gate result and tail>\",\n  \"summary\": \"<how both intents were preserved>\",\n  \"blockedReason\": \"<fail only>\"\n}\n```\n\nStore this object exactly once through the dispatch-scoped `store_result` tool. Only a\n`result-stored` acknowledgement permits the final response. Then reply with the\nprepared dispatch handle only; never return the result body or a capability.",
    privilege: "RW",
    exposedTools: "Disallowed: Agent",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/implement-conflict-resolver/input",
      "title": "implement-conflict-resolver input",
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string",
          "pattern": "^T[0-9]+$"
        },
        "headline": {
          "type": "string",
          "minLength": 1
        },
        "description": {
          "type": "string"
        },
        "worktreePath": {
          "type": "string",
          "minLength": 1
        },
        "branch": {
          "type": "string",
          "description": "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
          "pattern": "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$"
        },
        "baseCommit": {
          "type": "string",
          "minLength": 1
        },
        "conflictingFiles": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1,
          "description": "The conflicting files from git status."
        },
        "baseSideNote": {
          "type": "string",
          "description": "Optional one-line note on what the base-side change did."
        }
      },
      "required": [
        "taskId",
        "worktreePath",
        "branch",
        "baseCommit",
        "conflictingFiles"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/implement-conflict-resolver/output",
      "title": "implement-conflict-resolver result",
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string",
          "pattern": "^T[0-9]+$"
        },
        "status": {
          "type": "string",
          "enum": [
            "pass",
            "fail"
          ]
        },
        "resultCommit": {
          "type": [
            "string",
            "null"
          ]
        },
        "filesResolved": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "checkSummary": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "blockedReason": {
          "type": "string"
        }
      },
      "required": [
        "taskId",
        "status",
        "resultCommit",
        "filesResolved",
        "checkSummary",
        "summary"
      ],
      "additionalProperties": false
    },
  },
  {
    id: "investigate-explorer",
    name: "investigate-explorer",
    kind: "agent-subagent",
    source: "agents/investigate-explorer.md",
    description: "Read-only investigator that gathers cited evidence for one causal hypothesis and requests an isolated probe when execution is necessary.",
    inputs: [
  "hypothesis id, verbatim statement, defect/branch context, and optional leads"
],
    outputs: [
  "structured evidence result"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "read-only; no ledger mutation, repository edit, command execution, or child dispatch"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"hypothesis id, verbatim statement, defect/branch context, and optional leads\"\noutputs:\n  - \"structured evidence result\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"read-only; no ledger mutation, repository edit, command execution, or child dispatch\"\n```\n\nInvestigate one hypothesis. Inspect repository sources and authoritative\nreferences. Do not mutate state, execute commands, adjudicate the hypothesis,\nor spawn a child. When execution would provide decisive evidence, request an\nexact probe.\n\nFor every evidence item, cite a precise file location or URL, quote a short\nverbatim excerpt, and explain whether it supports or contradicts the statement.\nReturn no citation you did not inspect.\n\n```json\n{\n  \"hypothesisId\": \"<id>\",\n  \"evidence\": [\n    {\n      \"n\": 1,\n      \"citation\": \"<path:line-range or URL>\",\n      \"excerpt\": \"<verbatim excerpt>\",\n      \"relevance\": \"<supports or contradicts, and why>\"\n    }\n  ],\n  \"lean\": \"supports | contradicts | mixed | insufficient\",\n  \"notes\": \"<optional next lead>\",\n  \"probeRequest\": {\n    \"what\": \"<exact commands or test target>\",\n    \"why\": \"<what static inspection cannot determine>\"\n  }\n}\n```\n\nOmit `probeRequest` unless required; when present, set `lean` to\n`insufficient`. An empty evidence array is preferable to fabrication.\n\nThe result object must include the evidence summary.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RO",
    exposedTools: "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Bash, Agent",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/investigate-explorer/input",
      "title": "investigate-explorer input",
      "type": "object",
      "properties": {
        "hypothesisId": {
          "type": "string",
          "description": "The hypothesis id H passed in the dispatch prompt (e.g. H7).",
          "pattern": "^H[0-9]+$"
        },
        "statement": {
          "type": "string",
          "description": "The candidate root cause to test, verbatim.",
          "minLength": 1
        },
        "branchContext": {
          "type": "string",
          "description": "The defect under investigation, parent hypothesis, sibling findings, and what to confirm/rule out.",
          "minLength": 1
        },
        "leads": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional specific leads to chase (files, symbols, error messages, URLs)."
        }
      },
      "required": [
        "hypothesisId",
        "statement",
        "branchContext"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/investigate-explorer/output",
      "title": "investigate-explorer evidence",
      "type": "object",
      "properties": {
        "hypothesisId": {
          "type": "string",
          "pattern": "^H[0-9]+$"
        },
        "evidence": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "n": {
                "type": "integer",
                "minimum": 1
              },
              "citation": {
                "type": "string",
                "description": "A path:line-range, a URL, or (prober) the exact command run.",
                "minLength": 1
              },
              "excerpt": {
                "type": "string",
                "description": "A 3-5 line VERBATIM excerpt from the cited location, or verbatim command output.",
                "minLength": 1
              },
              "relevance": {
                "type": "string",
                "description": "One line: how this bears on H, and whether it SUPPORTS or CONTRADICTS.",
                "minLength": 1
              }
            },
            "required": [
              "n",
              "citation",
              "excerpt",
              "relevance"
            ],
            "additionalProperties": false
          }
        },
        "lean": {
          "type": "string",
          "enum": [
            "supports",
            "contradicts",
            "mixed",
            "insufficient"
          ]
        },
        "notes": {
          "type": "string"
        },
        "probeRequest": {
          "type": "object",
          "properties": {
            "what": {
              "type": "string",
              "description": "Commands / builds / tests the orchestrator must RUN to gather decisive evidence.",
              "minLength": 1
            },
            "why": {
              "type": "string",
              "description": "Why read-only static inspection cannot settle H — what execution would reveal.",
              "minLength": 1
            }
          },
          "required": [
            "what",
            "why"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "hypothesisId",
        "evidence",
        "lean"
      ],
      "additionalProperties": false
    },
  },
  {
    id: "investigate-prober",
    name: "investigate-prober",
    kind: "agent-subagent",
    source: "agents/investigate-prober.md",
    description: "Execute one requested investigative probe in an isolated worktree and return cited evidence without persisting changes.",
    inputs: [
  "hypothesis, exact probe request, branch context, worktree, and base commit"
],
    outputs: [
  "structured evidence result"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "worktree-local execution only; no network, dependency installation, ledger mutation, or persisted change"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"hypothesis, exact probe request, branch context, worktree, and base commit\"\noutputs:\n  - \"structured evidence result\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"worktree-local execution only; no network, dependency installation, ledger mutation, or persisted change\"\n```\n\nRun exactly the requested probe inside the supplied throwaway worktree. Verify\nthe base before executing. You may create temporary worktree-local files and\nrun existing tests/builds, but may not use the network, install dependencies,\ncommit, edit the main checkout, mutate the ledger, adjudicate, or spawn a\nchild. Leave no intended source change; the orchestrator discards the worktree.\n\nReturn precise file, URL, or command citations with verbatim excerpts. For a\ncommand result, the citation is the exact command and the excerpt is observed\noutput.\n\n```json\n{\n  \"hypothesisId\": \"<id>\",\n  \"evidence\": [\n    {\n      \"n\": 1,\n      \"citation\": \"<path:line-range, URL, or exact command>\",\n      \"excerpt\": \"<verbatim excerpt or output>\",\n      \"relevance\": \"<supports or contradicts, and why>\"\n    }\n  ],\n  \"lean\": \"supports | contradicts | mixed | insufficient\",\n  \"notes\": \"<optional next lead or unavailable requirement>\"\n}\n```\n\nReturn no `probeRequest`; you are the execution arm. An empty evidence array is\npreferable to an unobserved claim. The result object must include the evidence\nsummary.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RW",
    exposedTools: "Disallowed: Agent; isolation: worktree",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/investigate-prober/input",
      "title": "investigate-prober input",
      "type": "object",
      "properties": {
        "hypothesisId": {
          "type": "string",
          "pattern": "^H[0-9]+$"
        },
        "statement": {
          "type": "string",
          "description": "The candidate root cause to test, verbatim.",
          "minLength": 1
        },
        "probeRequest": {
          "type": "object",
          "description": "The explorer's probe request: what to run and why it settles H.",
          "properties": {
            "what": {
              "type": "string",
              "minLength": 1
            },
            "why": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "what",
            "why"
          ],
          "additionalProperties": false
        },
        "branchContext": {
          "type": "string",
          "description": "The defect, parent hypothesis, sibling findings, and the base commit/branch the throwaway worktree was cut from.",
          "minLength": 1
        },
        "leads": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional specific leads to chase (files, symbols, commands)."
        }
      },
      "required": [
        "hypothesisId",
        "statement",
        "probeRequest",
        "branchContext"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/investigate-prober/output",
      "title": "investigate-prober evidence",
      "type": "object",
      "properties": {
        "hypothesisId": {
          "type": "string",
          "pattern": "^H[0-9]+$"
        },
        "evidence": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "n": {
                "type": "integer",
                "minimum": 1
              },
              "citation": {
                "type": "string",
                "description": "A path:line-range, a URL, or (prober) the exact command run.",
                "minLength": 1
              },
              "excerpt": {
                "type": "string",
                "description": "A 3-5 line VERBATIM excerpt from the cited location, or verbatim command output.",
                "minLength": 1
              },
              "relevance": {
                "type": "string",
                "description": "One line: how this bears on H, and whether it SUPPORTS or CONTRADICTS.",
                "minLength": 1
              }
            },
            "required": [
              "n",
              "citation",
              "excerpt",
              "relevance"
            ],
            "additionalProperties": false
          }
        },
        "lean": {
          "type": "string",
          "enum": [
            "supports",
            "contradicts",
            "mixed",
            "insufficient"
          ]
        },
        "notes": {
          "type": "string"
        }
      },
      "required": [
        "hypothesisId",
        "evidence",
        "lean"
      ],
      "additionalProperties": false
    },
  },
  {
    id: "research-explorer",
    name: "research-explorer",
    kind: "agent-subagent",
    source: "agents/research-explorer.md",
    description: "Read-only researcher that gathers cited repository and external evidence for one candidate answer and requests an experiment when needed.",
    inputs: [
  "hypothesis id, statement, research/branch context, and optional leads"
],
    outputs: [
  "structured evidence result"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "read-only; no ledger mutation, repository edit, command execution, or child dispatch"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"hypothesis id, statement, research/branch context, and optional leads\"\noutputs:\n  - \"structured evidence result\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"read-only; no ledger mutation, repository edit, command execution, or child dispatch\"\n```\n\nResearch one candidate answer. Inspect repository material and authoritative,\ncurrent external sources. Prefer primary sources. Do not mutate state, execute\ncommands, adjudicate, or spawn a child.\n\nEvery evidence item needs a precise file location or URL, short verbatim\nexcerpt, and relevance. For external evidence, include authority and date in\nthe relevance. Never cite a source you did not open.\n\n```json\n{\n  \"hypothesisId\": \"<id>\",\n  \"evidence\": [\n    {\n      \"n\": 1,\n      \"citation\": \"<path:line-range or URL>\",\n      \"excerpt\": \"<verbatim excerpt>\",\n      \"relevance\": \"<supports or contradicts, why, and source authority/date>\"\n    }\n  ],\n  \"lean\": \"supports | contradicts | mixed | insufficient\",\n  \"notes\": \"<optional next lead>\",\n  \"probeRequest\": {\n    \"what\": \"<exact experiment, benchmark, build, or test>\",\n    \"why\": \"<what reading cannot determine>\"\n  }\n}\n```\n\nOmit `probeRequest` unless execution is necessary; when present, set `lean` to\n`insufficient`. An empty evidence array is preferable to fabrication. The\nresult object must include the evidence summary.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RO",
    exposedTools: "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Bash, Agent",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/research-explorer/input",
      "title": "research-explorer input",
      "type": "object",
      "properties": {
        "hypothesisId": {
          "type": "string",
          "description": "The hypothesis id H passed in the dispatch prompt (e.g. H7).",
          "pattern": "^H[0-9]+$"
        },
        "statement": {
          "type": "string",
          "description": "The candidate answer to the research question to test, verbatim.",
          "minLength": 1
        },
        "branchContext": {
          "type": "string",
          "description": "The research question under study, parent hypothesis, sibling findings, and what to confirm/rule out.",
          "minLength": 1
        },
        "leads": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional specific leads to chase (files, symbols, search terms, URLs)."
        }
      },
      "required": [
        "hypothesisId",
        "statement",
        "branchContext"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/research-explorer/output",
      "title": "research-explorer evidence",
      "type": "object",
      "properties": {
        "hypothesisId": {
          "type": "string",
          "pattern": "^H[0-9]+$"
        },
        "evidence": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "n": {
                "type": "integer",
                "minimum": 1
              },
              "citation": {
                "type": "string",
                "description": "A path:line-range, a URL, or (prober) the exact command run.",
                "minLength": 1
              },
              "excerpt": {
                "type": "string",
                "description": "A 3-5 line VERBATIM excerpt from the cited location, or verbatim command output.",
                "minLength": 1
              },
              "relevance": {
                "type": "string",
                "description": "One line: how this bears on H, and whether it SUPPORTS or CONTRADICTS.",
                "minLength": 1
              }
            },
            "required": [
              "n",
              "citation",
              "excerpt",
              "relevance"
            ],
            "additionalProperties": false
          }
        },
        "lean": {
          "type": "string",
          "enum": [
            "supports",
            "contradicts",
            "mixed",
            "insufficient"
          ]
        },
        "notes": {
          "type": "string"
        },
        "probeRequest": {
          "type": "object",
          "properties": {
            "what": {
              "type": "string",
              "description": "Experiment / benchmark / build / test the orchestrator must RUN to gather decisive evidence.",
              "minLength": 1
            },
            "why": {
              "type": "string",
              "description": "Why read-only static and web inspection cannot settle H — what execution would reveal.",
              "minLength": 1
            }
          },
          "required": [
            "what",
            "why"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "hypothesisId",
        "evidence",
        "lean"
      ],
      "additionalProperties": false
    },
  },
  {
    id: "research-experimenter",
    name: "research-experimenter",
    kind: "agent-subagent",
    source: "agents/research-experimenter.md",
    description: "Execute one research probe in a discardable worktree, with network access when needed, and return cited evidence without persisting changes.",
    inputs: [
  "hypothesis, exact probe request, branch context, worktree, and base commit"
],
    outputs: [
  "structured evidence result"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "network and worktree-local installs allowed; no ledger mutation, main-checkout change, commit, or child dispatch"
],
    promptTemplate: "## Catalogue\n```yaml\ninputs:\n  - \"hypothesis, exact probe request, branch context, worktree, and base commit\"\noutputs:\n  - \"structured evidence result\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"network and worktree-local installs allowed; no ledger mutation, main-checkout change, commit, or child dispatch\"\n```\n\nRun exactly the requested experiment in the supplied discardable worktree.\nVerify the base first. Network access and worktree-local dependency installation\nare allowed when the probe requires them. Confine every write and installation\nto the worktree; do not commit, mutate the ledger or main checkout, adjudicate,\nor spawn a child.\n\nReturn precise file, URL, or command citations with verbatim excerpts. Preserve\nobserved benchmark values and relevant environment details.\n\n```json\n{\n  \"hypothesisId\": \"<id>\",\n  \"evidence\": [\n    {\n      \"n\": 1,\n      \"citation\": \"<path:line-range, URL, or exact command>\",\n      \"excerpt\": \"<verbatim excerpt or output>\",\n      \"relevance\": \"<supports or contradicts, and why>\"\n    }\n  ],\n  \"lean\": \"supports | contradicts | mixed | insufficient\",\n  \"notes\": \"<optional next lead or limitation>\"\n}\n```\n\nReturn no `probeRequest`; report inconclusive execution with\n`lean: \"insufficient\"`. An empty evidence array is preferable to an unobserved\nclaim. The result object must include the evidence summary.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RW",
    exposedTools: "Disallowed: Agent; isolation: worktree",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/research-experimenter/input",
      "title": "research-experimenter input",
      "type": "object",
      "properties": {
        "hypothesisId": {
          "type": "string",
          "pattern": "^H[0-9]+$"
        },
        "statement": {
          "type": "string",
          "description": "The candidate answer to the research question to test, verbatim.",
          "minLength": 1
        },
        "probeRequest": {
          "type": "object",
          "description": "The research-explorer's probe request: what to run and why it settles H.",
          "properties": {
            "what": {
              "type": "string",
              "minLength": 1
            },
            "why": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "what",
            "why"
          ],
          "additionalProperties": false
        },
        "branchContext": {
          "type": "string",
          "description": "The research question, parent hypothesis, sibling findings, and the base commit/branch the throwaway worktree was cut from.",
          "minLength": 1
        },
        "leads": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional specific leads to chase (files, symbols, commands, packages, URLs)."
        }
      },
      "required": [
        "hypothesisId",
        "statement",
        "probeRequest",
        "branchContext"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/research-experimenter/output",
      "title": "research-experimenter evidence",
      "type": "object",
      "properties": {
        "hypothesisId": {
          "type": "string",
          "pattern": "^H[0-9]+$"
        },
        "evidence": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "n": {
                "type": "integer",
                "minimum": 1
              },
              "citation": {
                "type": "string",
                "description": "A path:line-range, a URL, or (prober) the exact command run.",
                "minLength": 1
              },
              "excerpt": {
                "type": "string",
                "description": "A 3-5 line VERBATIM excerpt from the cited location, or verbatim command output.",
                "minLength": 1
              },
              "relevance": {
                "type": "string",
                "description": "One line: how this bears on H, and whether it SUPPORTS or CONTRADICTS.",
                "minLength": 1
              }
            },
            "required": [
              "n",
              "citation",
              "excerpt",
              "relevance"
            ],
            "additionalProperties": false
          }
        },
        "lean": {
          "type": "string",
          "enum": [
            "supports",
            "contradicts",
            "mixed",
            "insufficient"
          ]
        },
        "notes": {
          "type": "string"
        }
      },
      "required": [
        "hypothesisId",
        "evidence",
        "lean"
      ],
      "additionalProperties": false
    },
  },
  {
    id: "begin",
    name: "/cq:begin",
    kind: "orchestrator",
    source: "commands/cq/begin.md",
    description: "Split a mixed request into plan, investigate, and research intakes, then run one sequencer pass.",
    inputs: [
  "free-form request containing any mix of capabilities, faults, and empirical questions"
],
    outputs: [
  "deduplicated flow intakes, one aggregate ambiguity question, one sequencer pass, and a routing report"
],
    ioSchema: [
  "new capability -> goal; existing fault -> defect; empirical unknown -> research; user-only choice -> question"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:ledger-response-contract}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"free-form request containing any mix of capabilities, faults, and empirical questions\"\noutputs:\n  - \"deduplicated flow intakes, one aggregate ambiguity question, one sequencer pass, and a routing report\"\nioSchema:\n  - \"new capability -> goal; existing fault -> defect; empirical unknown -> research; user-only choice -> question\"\n```\n\nSplit `$ARGUMENTS` into independently actionable segments while preserving\ntheir detail. Ask for input if it is empty.\n\n## Route\n\nClassify each segment:\n\n| Meaning | Route |\n| --- | --- |\n| new capability or change | plan |\n| existing incorrect behavior | investigate |\n| empirically answerable unknown | research |\n| user-only requirement/preference or genuinely ambiguous intent | ambiguity question |\n\nDo not ask for routing confirmation when the segment is clear.\n\nSearch the target ledger for each clear segment:\n\n- exact live duplicate: report and skip;\n- clear extension of a live goal: use the `CQ::plan/follow-up` bootstrap;\n- otherwise create a fresh intake through the target command's bootstrap.\n\nCollect all ambiguous segments into one open question beneath one coordination\nmilestone. Include each segment verbatim, its plausible routes, and useful\nsuggestions. Do not intake those segments until answered.\n\n## Intake and advance\n\nBootstrap all clear segments before advancing:\n\n- plan: create the coordination milestone and clarifying goal;\n- goal extension: validate, append scope, link ideas if present, and enter its\n  documented follow-up path;\n- investigate: create the coordination milestone and open defect;\n- research: create the coordination milestone and open research.\n\nDo not run each flow separately. After all intakes, run `CQ::advance` inline\nonce so its predicates advance the entire batch. The sequencer owns the sole\nrun-level handoff and all child logs. If no segment was intaked, skip it.\n\nReport a routing table with a short segment label, item reference, flow, and\nduplicate/ambiguous disposition. Include the ambiguity question and next\naction.\n\nWrite a handoff only when the sequencer did not run and an ambiguity question\nblocks intake: `answers-required`, `flow: \"begin\"`, the question reference, and\n`blockingQuestions`. Exact-duplicate-only requests need no handoff.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "advance",
    name: "/cq:advance",
    kind: "orchestrator",
    source: "commands/cq/advance.md",
    description: "Advance every CQ flow to quiescence, then report whether the run drained or stopped on user input.",
    inputs: [
  "no arguments; current ledger state"
],
    outputs: [
  "root-caused defects seeded into fix goals",
  "all actionable investigate, plan, research, and implement work advanced to quiescence",
  "one run-level handoff and a drained/blocked/mixed report"
],
    ioSchema: [
  "authoritative readiness comes from ledger::derive_predicates",
  "cycle order: investigate -> seed -> plan -> research -> implement -> investigate re-check",
  "no fixed iteration cap; stop only after a full no-progress cycle"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:advance-run-guard}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"no arguments; current ledger state\"\noutputs:\n  - \"root-caused defects seeded into fix goals\"\n  - \"all actionable investigate, plan, research, and implement work advanced to quiescence\"\n  - \"one run-level handoff and a drained/blocked/mixed report\"\nioSchema:\n  - \"authoritative readiness comes from ledger::derive_predicates\"\n  - \"cycle order: investigate -> seed -> plan -> research -> implement -> investigate re-check\"\n  - \"no fixed iteration cap; stop only after a full no-progress cycle\"\n```\n\nYou are the whole-ledger sequencer. Run the four flow commands INLINE in this\nsession; do not dispatch their agents yourself or duplicate their internal\nlogic. Subcommands suppress standalone handoffs while chained here. Ledger state,\nnot prose output, determines the next action.\n\n## Authoritative state\n\nAt run start and after every stage that may mutate the ledger, call:\n\n```\nledger::derive_predicates()\n```\n\nIt returns:\n\n```json\n{\n  \"pInvestigate\": { \"value\": true, \"items\": [\"<defect-id>\"] },\n  \"pSeed\": { \"value\": true, \"items\": [\"<defect-id>\"] },\n  \"pPlan\": { \"value\": true, \"items\": [\"<goal-id>\"] },\n  \"pResearch\": { \"value\": true, \"items\": [\"<research-id>\"] },\n  \"pImplement\": { \"value\": true, \"items\": [\"<task-id>\"] },\n  \"openQuestionGate\": { \"value\": false, \"items\": [] },\n  \"belowFloor\": { \"value\": false, \"items\": [] },\n  \"planBusy\": { \"value\": false, \"items\": [] },\n  \"goalDrift\": { \"value\": false, \"items\": [] }\n}\n```\n\nTrust these derived values. Use `snapshot()` or focused item reads only for\nnarrative needed by the selected action. Never reimplement readiness by scanning\nentire ledgers or parsing a child command's report.\n\n## Cycle\n\nRepeat the following order. Re-read predicates after each numbered stage.\n\n1. **Investigate.** For every id currently returned by `pInvestigate.items`,\n   run `CQ::investigate/advance <defect-id>` INLINE. Continue past one parked\n   defect; another defect may remain actionable.\n\n2. **Seed fixes.** For `pSeed.items`, fetch the full root-caused defects and\n   process deterministic chunks of at most five. For each chunk:\n\n   - create one coordination milestone;\n   - create one `goals` item in `planning`, with a title/description covering\n     every defect, `sourceRefs` containing each `defects:<id>`, and enough\n     root-cause/fix context for planning;\n   - append `goals:<new-goal>` to each defect's `ledgerRefs`, preserving existing\n     refs.\n\n   A root-caused defect already owned by a goal must not seed another. Defects\n   below the configured severity floor remain visible through `belowFloor` but\n   do not seed automatically.\n\n3. **Plan.** If `pPlan.value`, run `CQ::plan/advance` INLINE once; that command\n   advances every unlocked planning goal and owns auto-investigation of defects\n   filed during plan review.\n\n4. **Research.** For every id currently returned by `pResearch.items`, run\n   `CQ::research/advance <research-id>` INLINE.\n\n5. **Implement.** If `pImplement.value`, run `CQ::implement/advance` INLINE\n   once; it owns worker dispatch, review, merge-back, and task status.\n\n6. **Re-check investigation.** Re-read predicates and run newly actionable\n   defects before deciding whether the cycle made progress. Planning,\n   research, and implementation can expose new defects.\n\nAfter any ledger mutation, begin another cycle. Do not impose an iteration,\ntime, or token cap.\n\n## Legitimate stops\n\nA full cycle may stop only when it made no ledger progress and one of these\nconditions holds:\n\n- all five actionable predicates are false (`drained`);\n- every remaining actionable branch waits on open requirements questions\n  (`answers-required`);\n- progress requires an operation CQ cannot perform, such as missing credentials,\n  unavailable infrastructure, deployment, or an external manual action\n  (`user-action-required`);\n- both question-gated and external-action-gated branches remain (`mixed`);\n- predicates remain actionable but a complete cycle produces no legal mutation\n  and no legitimate user gate (`illness-detected`).\n\nDo not ask for confirmation between stages. Fix-versus-wontfix, whether a\nconfirmed defect should be fixed, cost, blast radius, public API impact, and\nscope size are not requirements questions. Running this command authorizes\ncontinued in-scope repair. Ask only when the answer changes required behavior or\nprovides otherwise-unavailable external information or authority.\n\n`belowFloor`, `planBusy`, research parking, and `goalDrift` are diagnostic\ncompanions, not reasons by themselves to claim the run drained. Report them when\nthey explain inactive work.\n\n## End-of-run maintenance\n\nAfter quiescence:\n\n1. For each active non-goal milestone whose referenced items are all terminal,\n   mark it `done` and archive it. Never auto-close goals.\n2. Inspect implementation worktrees. Remove only a task worktree whose commit is\n   already an ancestor of the integration branch or whose patch is equivalent to\n   the landed change. Preserve any worktree carrying novel commits, report it,\n   then prune stale worktree metadata. Never infer safety from a branch name\n   alone.\n3. Make no git commit or push for ledger mutations; the configured ledger\n   backend owns persistence.\n\n## Handoff and report\n\nWrite exactly one `handoffs` item for the whole run:\n\n- `status`: `drained`, `answers-required`, `user-action-required`, `mixed`, or\n  `illness-detected`;\n- `flow`: `advance`;\n- `summary`: stages run, durable ids/statuses changed, and final predicate state;\n- `blockingQuestions`: open question ids when applicable;\n- `handoffReasons`: external actions or illness evidence when applicable;\n- `ledgerRefs`: the affected defects, goals, researches, and tasks.\n\nThen report:\n\n- the terminal category;\n- changes grouped by investigate, seed, plan, research, and implement;\n- required user answers/actions, if any;\n- below-floor, parked, drifted, or preserved-worktree diagnostics;\n- the handoff id.\n\nBefore returning, perform the surface-specific run-guard cleanup stated above.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "plan",
    name: "/cq:plan",
    kind: "orchestrator",
    source: "commands/cq/plan.md",
    description: "Create plan-flow goals from free text or idea ids, then run their first guarded planning round.",
    inputs: [
  "free-text goal description, or one or more idea ids without interleaving"
],
    outputs: [
  "one coordination milestone and clarifying goal per intake",
  "bidirectional idea/goal links and planned idea status when idea-seeded",
  "first guarded planning round and one outer handoff"
],
    ioSchema: [
  "bootstrap only; plan advance owns questions, claims, drafts, reviews, and finalization"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:subagent-dispatch}}\n{{cq:fragment:ledger-response-contract}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"free-text goal description, or one or more idea ids without interleaving\"\noutputs:\n  - \"one coordination milestone and clarifying goal per intake\"\n  - \"bidirectional idea/goal links and planned idea status when idea-seeded\"\n  - \"first guarded planning round and one outer handoff\"\nioSchema:\n  - \"bootstrap only; plan advance owns questions, claims, drafts, reviews, and finalization\"\n```\n\nCreate goals for new capabilities. A report that existing behavior fails belongs\nto investigation instead; do not turn a fault report directly into a goal.\n\n## Parse and deduplicate\n\nAn empty argument requires user input. An idea id is `I` followed by decimal\ndigits. If every whitespace-delimited token matches that grammar, process each\nidea independently. Otherwise treat the entire argument as one free-text\ndescription; do not interleave ids and prose.\n\nFor each prospective goal, search active goals by key terms. If one already\ncovers the scope, report it and skip creation.\n\n## Bootstrap\n\nFor free text:\n\n1. Create a coordination milestone titled `Plan: <short goal>`.\n2. Create a `clarifying` goal beneath it with a short title and the complete\n   description.\n\nFor each idea id:\n\n1. Fetch the full idea; report and skip missing ids.\n2. Create the milestone and goal using the idea title and verbatim description.\n3. Merge `ideas:<ideaId>` into the goal's `fields.sourceRefs` and\n   `goals:<goalId>` into the idea's `fields.ledgerRefs`, preserving all entries\n   already stored in both arrays.\n4. Set the idea to `planned`.\n\nThe coordination milestone contains the goal, clarification questions, reviews,\nand approval decision. Draft publication creates separate work milestones.\n\n## First planning round\n\nRun `CQ::plan/advance <goalId>` inline for every new goal. That command owns the\nclaim, planner dispatch, guarded mutation, defect investigation, and child\nlogs. Suppress its handoff because this wrapper writes the single outer record.\nIts defect phase may run `CQ::investigate/advance` inline.\n\nAfter the round, read the goal-linked open questions and report the milestone,\ngoal, source idea when applicable, current phase, questions to answer, and any\ndefect investigation outcome. Tell the user to answer questions in a client and\nrun plan advance again.\n\nWrite one append-only plan handoff using the plan-advance mapping. A normal\nfirst round stops as `answers-required`, linked to the goal with\n`blockingQuestions` and the child log paths. If several goals produce different\nstop causes, use the corresponding aggregate status.\n\nDo not generate questions, mutate managed plan state, publish a draft, or lock\na decision in this command.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "plan/advance",
    name: "/cq:plan:advance",
    kind: "orchestrator",
    source: "commands/cq/plan/advance.md",
    description: "Advance one or all unlocked goals through guarded planning, review, and defect investigation until planned or waiting.",
    inputs: [
  "optional goal id; empty selects every clarifying/planning goal",
  "full goal, answered questions, current draft, latest review, planner/reviewer configuration"
],
    outputs: [
  "guarded claim lifecycle, one current draft, one review per round, final executable manifest or a waiting state",
  "inline investigation of actionable defects filed by the round",
  "standalone handoff"
],
    ioSchema: [
  "planner result: typed PlanStepResult or candidate DAG",
  "review result: {summary,verdict,new_questions[],criticism[],defects[]}",
  "one active fenced claim per goal and one terminal claim operation per round"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:ledger-response-contract}}\n\n## Catalogue\n\n```yaml\ninputs:\n  - \"optional goal id; empty selects every clarifying/planning goal\"\n  - \"full goal, answered questions, current draft, latest review, planner/reviewer configuration\"\noutputs:\n  - \"guarded claim lifecycle, one current draft, one review per round, final executable manifest or a waiting state\"\n  - \"inline investigation of actionable defects filed by the round\"\n  - \"standalone handoff\"\nioSchema:\n  - \"planner result: typed PlanStepResult or candidate DAG\"\n  - \"review result: {summary,verdict,new_questions[],criticism[],defects[]}\"\n  - \"one active fenced claim per goal and one terminal claim operation per round\"\n```\n\nYou orchestrate the planner-reviewer loop. Children do not own guarded plan\nstate. Claim before planner dispatch, keep the claim through draft/review\niterations, and end it only by pause, abandon, or finalize.\n\n{{cq:fragment:subagent-dispatch}}\n\n## Select goals\n\nWith an argument, target that goal. Without one, fetch all active goals and\nselect `clarifying` or `planning`. Never create a goal here. An empty target set\nmeans the flow is drained; autonomous defect seeding belongs to the outer\nadvance command.\n\nAdvance goals independently. A waiting goal does not prevent other targets\nfrom progressing.\n\n## Per-goal loop\n\nEach iteration must dispatch a child or change state. Stop after a terminal\ntoken or two consecutive read-only passes. Terminal tokens are\n`awaiting-answers`, `awaiting-research`, `completed`, and `noop`.\n\nWhen `CQ::plan/follow-up` transfers an acknowledged active follow-up claim,\nretain its claim id, generation, and fence token and resume at **§2. Resolve\nplanners and dispatch** with that claim. Do not run §1 or mint an initial claim.\nOnly this explicit in-memory transfer bypasses §1; every normal invocation\nstarts at the pre-claim gate.\n\n### 1. Pre-claim gate and claim\n\nRead the goal and exact goal-linked questions/research waits.\n\n- An open question → `awaiting-answers`.\n- Any waited research in `open`, `wip`, or `inconclusive` →\n  `awaiting-research`.\n\nOtherwise mint a fresh request id and secret fence token and call `claim_plan`\nwith `purpose: \"initial\"` and the observed plan generation. Keep the\nacknowledged claim id, generation, and token in memory; never log the token.\n\nTreat claim conflicts as follows:\n\n- active claim: report the goal busy;\n- active research wait: `awaiting-research`;\n- stale generation: reread and retry once;\n- terminal/phase conflict: report and skip;\n- request reuse or fence mismatch: stop with an invariant failure.\n\n### 2. Resolve planners and dispatch\n\nRead `ledger::get_config(\"planners\")` once. Honor any session override.\n\n#### Single-planner fallback\n\nDispatch `plan-advance` in default mode with the goal id. It returns one\nschema-valid PlanStepResult and writes nothing. Reject the whole result on any\ncontract failure; never apply a valid prefix.\n\nApply exactly one matching guarded operation using the active claim. Mint a\nfresh operation id for a new intent and reuse it only when retrying the exact\nsame payload after a lost response. Supply `defectsToFile` as the same\noperation's `reviewDefects`.\n\n- `questions` → pause with question drafts; goal returns to `clarifying`;\n  token `awaiting-answers`.\n- `researches` → pause with research drafts; goal remains `planning` with\n  `waitingResearches`; token `awaiting-research`.\n- `draft` → publish the complete manifest; claim stays active; token\n  `review-requested`.\n- `finalize` → finalize the exact current draft using the named go-ahead\n  review and decision; goal becomes `planned`; token `completed`.\n- `awaiting` or `noop` → abandon the claim without effects; corresponding\n  terminal token.\n\nPersist optional grounding on the goal. `release_plan_claim(kind: \"abandon\")`\nuses the public claim id/generation and no fence token; pause, publish, and\nfinalize require the token. On a lost/stale claim, stop instead of reclaiming\nover another round.\n\n#### Configured planner panel\n\nDispatch every configured planner concurrently in candidate mode through its\nconfigured adapter. Each returns the same candidate DAG and writes nothing.\n**Candidate usable-payload rule.** Fence-strip and validate stdout first. A\ncomplete, parseable candidate counts as a usable candidate despite a non-zero\nshell exit; log that exit anomaly. Require full-object validation before\naccepting the candidate. Only empty, unparseable, invalid, or off-contract\ncandidate output abstains and is logged.\n\n**Candidate no-timeout rule.** No wall-clock timeout is imposed. Fence-strip\nand validate stdout first. A complete, parseable candidate counts as a usable\ncandidate despite a non-zero shell exit; log that exit anomaly. A non-zero exit\ncauses abstention only when no complete, parseable, fully validated candidate\nexists; a stalled adapter remains an operational failure rather than a silent\nabstention. If all abstain, use the single-planner fallback under the same\nclaim.\n\nSynthesize one manifest:\n\n1. choose the candidate with the strongest grounding and decomposition;\n2. fold in distinct milestones, tasks, acceptance criteria, and dependency\n   edges from other candidates;\n3. deduplicate overlaps;\n4. assign stable milestone/task keys and translate title/headline references\n   into typed draft references. Copy every selected candidate task's\n   `ledgerRefs` into the synthesized draft task's `ledgerRefs`, merge them with\n   the mandatory `goals:<goalId>` owner reference, and de-duplicate without\n   moving any entry into `sourceRefs`.\n\nPublish that complete manifest under the active claim. Empty candidate DAGs\nmean clarification remains necessary: pause with concrete questions when\navailable, otherwise abandon and return `awaiting-answers`.\n\n### 3. Review a published draft\n\nResolve `ledger::get_config(\"reviewers\")` once and honor any session\noverride.\n\n#### Single-reviewer fallback\n\nSnapshot the highest goal-linked review id before dispatch. Dispatch\n`plan-reviewer` in fallback mode; it returns a structured verdict and writes\nexactly one review.\n\nAfter dispatch, require exactly one new goal-linked review above the snapshot.\nValidate the complete returned and persisted verdicts, including canonical\nserialized defect objects, and require equality. Zero/multiple reviews,\nmalformed data, or any mismatch fails the round before log attachment or\ndefect filing.\n\nStamp the recovered review with the exact current draft identity:\n`{goalId, claimId, generation, revision}`.\n\n#### Configured reviewer panel\n\nDispatch all configured reviewers concurrently through their adapters.\n**Configured reviewer wrapper rule.** Standalone non-interactive wrappers may\nfast-fail with a non-zero shell exit. Fence-strip and validate stdout first. A\ncomplete, parseable verdict counts as a vote despite a non-zero shell exit; log\nthat exit anomaly. Do not drop the emitted verdict solely for that exit.\n\nReviewers return structured verdicts and write nothing.\n**Reviewer usable-verdict rule.** Fence-strip and validate stdout first. A\ncomplete, parseable verdict counts as a vote despite a non-zero shell exit; log\nthat exit anomaly. Require full-object validation before accepting the verdict.\nOnly a returned failure without such a verdict, empty/malformed result, or\noff-enum verdict abstains and is logged. If all abstain, use the single-reviewer\nfallback.\n\nReconcile surviving reviews in configured order:\n\n- any `revise` wins; all must return `go-ahead` for approval;\n- union and source-tag `new_questions`, `criticism`, and structured `defects`;\n- deduplicate only equivalent findings;\n- `revise` requires at least one question or criticism.\n\nWrite exactly one aggregated review linked to the goal and stamp it with the\ncurrent draft identity.\n\nAfter either review path, continue the planner loop. The next planner result\nmust revise, ask questions, or finalize. There is no numeric cap while the\ndraft changes or criticism shrinks. An identical draft and unchanged\ncriticism across consecutive rounds constitutes a non-converging loop.\n\n## Auto-investigate filed defects\n\nAfter a goal's planner loop stops, query the ledger—not child prose—for\ngoal-linked defects in `open`, `wip`, or `inconclusive`. Deduplicate them and\nrun `CQ::investigate/advance` inline once per defect for this planning round.\nSuppress the nested handoff.\n\nDo not let open goal-clarification questions prevent investigation. Do not\nresume planning for a goal still in `clarifying`; a defect-seeded goal already\nin `planning` may resume immediately.\n\nStop the investigate/replan axis when any condition holds:\n\n- the defect already ran once this round;\n- no new confirmed node or correct evidence appeared;\n- a confirmed cause seeded or extended its fix goal;\n- replanning produced no new fix task or repeated the same task set;\n- two consecutive rounds produced no adjudicable evidence.\n\nFor non-converging or genuinely user-blocked cases, create an open question\nlinked to the affected defect and goal. A `root-caused` defect belongs to the\nouter advance command's seed stage, not another investigation pass.\n\nResearch items filed by planning are also driven by the outer advance command.\nThis command records the wait and stops; it does not run research inline.\n\n## Logs, report, and handoff\n\nPersist every child summary and available raw transcript through `cq log put`,\nattach logical paths to the affected item, and never log fence or capability\nsecrets.\n\nReport each goal's current phase and next action, waited research ids, finalized\nwork, and each investigated defect's outcome. Never auto-close a goal.\n\nWhen invoked standalone, write one append-only `handoffs` item:\n\n- `drained`: all targets planned/terminal;\n- `answers-required`: open linked questions block progress;\n- `user-action-required`: a named item requires a specific external action\n  only the user can perform;\n- `mixed`: several stop causes coexist;\n- `illness-detected`: a protocol or convergence invariant prevents progress.\n\nSet `flow: \"plan\"`, relevant goal/defect refs, required\n`blockingQuestions`/`handoffReasons`, and round log paths. Do not write a\nhandoff for ordinary context-window interruption. Never stop because of effort,\nelapsed time, or remaining work size.\n\nWhen invoked inline by another flow, suppress this handoff; the outermost\ncommand owns it.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "plan/follow-up",
    name: "/cq:plan:follow-up",
    kind: "orchestrator",
    source: "commands/cq/plan/follow-up.md",
    description: "Append scope to an existing non-terminal goal and route it into follow-up planning.",
    inputs: [
  "target goal id followed by free text or one or more idea ids"
],
    outputs: [
  "appended scope, optional idea links, follow-up planning round, and one outer handoff"
],
    ioSchema: [
  "terminal goals reject without mutation",
  "managed goals use the guarded follow-up claim; unmanaged goals use the legacy reopen transitions"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:subagent-dispatch}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"target goal id followed by free text or one or more idea ids\"\noutputs:\n  - \"appended scope, optional idea links, follow-up planning round, and one outer handoff\"\nioSchema:\n  - \"terminal goals reject without mutation\"\n  - \"managed goals use the guarded follow-up claim; unmanaged goals use the legacy reopen transitions\"\n```\n\nUse this for added capability scope on an existing `clarifying`, `planning`,\n`planned`, or `building` goal. Existing faults belong to investigation.\n\n## Parse and gate\n\nThe first token is the goal id. An idea id is `I` followed by decimal digits.\nIf every remaining token matches that grammar, use idea mode; otherwise treat\nthe entire remainder as free text. Reject an empty remainder. Fetch the full\ngoal. Missing, `done`, or `abandoned` goals stop without mutation; terminal\ngoals require a new goal.\n\nIn idea mode, fetch each idea, skip missing ids, and use its title and\ndescription as one follow-up section. In free-text mode, use the request\nverbatim. This preparation is read-only: do not update the goal or any idea\nyet.\n\n## Acquire managed authority\n\nInspect `planGeneration` before appending or linking anything.\n\nFor a protocol-managed goal, mint a fresh request id and secret fence token,\nthen call `claim_plan(purpose: \"follow-up\")` with the observed plan generation\nand write provenance. Never log the token. Any rejected claim result exits\nbefore appending scope or mutating the goal or ideas; report its conflict and\nperform no fallback raw transition. This rule covers every rejection,\nincluding a terminal or phase conflict, active claim or implementation,\nresearch wait, stale generation, request reuse, and fence mismatch.\n\nOn acknowledgement, keep the claim id, generation, and fence token in memory.\nThe claim has entered `planning` and superseded the prior unstarted manifest.\nDo not issue a raw status transition for this managed goal.\n\nAn unmanaged goal has no `planGeneration`; it does not use `claim_plan` and\ncontinues through the legacy path below.\n\n## Append and link\n\nReach this section only after a managed follow-up claim was acknowledged or\nthe goal was confirmed unmanaged.\n\nAppend each scope to the existing description without replacing history:\n\n```markdown\n## Follow-up (<date or ordinal>)\n<scope>\n```\n\nFor each idea, merge `ideas:<ideaId>` into the goal's `fields.sourceRefs` and\n`goals:<goalId>` into the idea's `fields.ledgerRefs`, preserving all entries\nalready stored in both arrays; then set the idea `planned`.\n\n## Enter planning\n\nFor an unmanaged goal, move `planned` or `building` through `planning` to\n`clarifying`; move `planning` to `clarifying`; leave `clarifying` unchanged.\n\nFor an unmanaged goal now in `clarifying`, run\n`CQ::plan/advance <goalId>` inline. It owns questions, guarded mutations,\ndefect investigation, and child logs. Suppress its handoff.\nIts defect phase may run `CQ::investigate/advance` inline.\n\nFor a managed goal with the acknowledged claim, enter `CQ::plan/advance` at\n**§2. Resolve planners and dispatch** and transfer the in-memory claim id,\ngeneration, and fence token. Do not run its §1 pre-claim gate or request a\nsecond `purpose: \"initial\"` claim. The resumed command owns planner/reviewer\ndispatch and every guarded publish, pause, abandon, or finalize operation under\nthe transferred claim. Suppress its handoff; its defect phase may run\n`CQ::investigate/advance` inline.\n\nReport appended scope, current phase, open question ids, the next plan-advance\naction, and any investigation outcome. Write one outer plan handoff using the\nplan-advance mapping and child log paths. Do not generate questions, publish a\ndraft, or lock a decision here.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "investigate",
    name: "/cq:investigate",
    kind: "orchestrator",
    source: "commands/cq/investigate.md",
    description: "Create or resume a defect, then run one investigation round.",
    inputs: [
  "free-text defect description or existing defect id"
],
    outputs: [
  "new/resumed defect, inline investigation round, and one outer handoff"
],
    ioSchema: [
  "new defects require headline, description, and critical|high|medium|low severity"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"free-text defect description or existing defect id\"\noutputs:\n  - \"new/resumed defect, inline investigation round, and one outer handoff\"\nioSchema:\n  - \"new defects require headline, description, and critical|high|medium|low severity\"\n```\n\nIf `$ARGUMENTS` names an existing defect, fetch it with full projection. Reject\nmissing or terminal items; otherwise resume it.\n\nFor free text:\n\n1. Search active defects by key terms and resume a matching item instead of\n   duplicating it.\n2. Infer severity:\n   - `critical`: security, data loss, crash, or system-wide block;\n   - `high`: major behavior unavailable without workaround;\n   - `medium`: degraded behavior with a workaround;\n   - `low`: cosmetic or narrow edge case.\n   Ask one question only when adjacent tiers remain genuinely ambiguous.\n3. Create an `Investigate: <short slug>` coordination milestone.\n4. Create an `open` defect with a concise headline, complete description, and\n   severity.\n\nRun `CQ::investigate/advance <defectId>` inline. It owns hypotheses, evidence,\nprobes, research escalation, adjudication, goal seeding, and child logs.\nSuppress its handoff because this wrapper writes one using the\ninvestigate-advance mapping.\n\nReport whether the defect was created or resumed, its milestone/severity, and\nthe complete round outcome. Resume later with investigate advance directly.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "investigate/advance",
    name: "/cq:investigate:advance",
    kind: "orchestrator",
    source: "commands/cq/investigate/advance.md",
    description: "Advance one defect investigation round: extend its hypothesis tree, gather and validate evidence, adjudicate nodes, and hand a confirmed cause to planning.",
    inputs: [
  "one defect id and its linked hypothesis/question/research state"
],
    outputs: [
  "validated hypothesis evidence and status changes",
  "optional execution probes or research escalation",
  "confirmed root cause, suggested fix, and defect-seeded planning goal"
],
    ioSchema: [
  "one resumable evidence/adjudication round per invocation",
  "parallel explorers only for independent roots; serial drilling within a branch",
  "explorer/prober output: {hypothesisId,evidence[],lean,notes?,probeRequest?}"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n{{cq:fragment:subagent-dispatch}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"one defect id and its linked hypothesis/question/research state\"\noutputs:\n  - \"validated hypothesis evidence and status changes\"\n  - \"optional execution probes or research escalation\"\n  - \"confirmed root cause, suggested fix, and defect-seeded planning goal\"\nioSchema:\n  - \"one resumable evidence/adjudication round per invocation\"\n  - \"parallel explorers only for independent roots; serial drilling within a branch\"\n  - \"explorer/prober output: {hypothesisId,evidence[],lean,notes?,probeRequest?}\"\n```\n\nYou own the investigation loop for one defect. Explorers and probers gather\nevidence; they never mutate the ledger or adjudicate. Re-derive state from the\nledger on every invocation. A round must dispatch a child or make a durable\nmutation; otherwise stop with a handoff instead of rereading indefinitely.\n\n## State and invariants\n\n1. Fetch the defect with `projection: \"full\"`. Stop on `resolved` or `wontfix`.\n2. Fetch linked hypotheses, questions, and researches with full projection.\n   Reconstruct hypothesis ancestry from `parentHypothesis`; every node must\n   retain `ledgerRefs: [\"defects:<defect-id>\"]`.\n3. An unanswered linked question parks the affected branch. Fold answered text\n   into the next framing.\n4. A hypothesis parked on `researches:<research-id>` remains parked while that\n   research is `open` or `wip`. On `concluded`, use its findings/conclusion as\n   evidence; on `inconclusive` or `abandoned`, resume from the remaining\n   evidence.\n5. Before forming or dispatching hypotheses, move an `open` defect to `wip`.\n   Never attempt the invalid direct transition from `open` to `root-caused`.\n6. Resolve the frontier model once with\n   `ledger::get_config(\"tiers\")`; use the configured frontier model\n   verbatim. If unavailable, inherit the current runtime model. Do not invent a\n   model identifier.\n\n## Round\n\n### 1. Form hypotheses\n\nIf the tree has no actionable node, create a small set of mutually distinct,\nfalsifiable root hypotheses. Otherwise select unresolved leaves whose parents\nhave enough validated evidence to justify drilling. Do not duplicate an\nexisting statement or create children merely to keep the loop active.\n\nEach new hypothesis includes:\n\n- a precise statement;\n- optional `parentHypothesis`;\n- `ledgerRefs: [\"defects:<defect-id>\"]`;\n- `status: \"open\"`.\n\n### 2. Gather evidence\n\nDispatch one `investigate-explorer` per selected node. Independent roots may run\nin parallel; descendants of one branch run serially because later framing\ndepends on earlier evidence.\n\nThe input must contain the hypothesis id and statement, defect/branch context,\nknown sibling or parent findings, and focused leads. The child returns numbered\nevidence with a precise citation, a three-to-five-line verbatim excerpt, a\nrelevance statement, and a non-binding lean.\n\nIf an explorer returns `probeRequest`, dispatch `investigate-prober` with the\nsame context plus `{what, why}` in an isolated throwaway worktree. The prober is\nlocal-only: no network, no persistent main-checkout edits. Harvest its evidence,\nthen remove the worktree. Never execute a probe in the main checkout.\n\nAfter every child returns, persist its summary through `cq log put` and its raw\ntranscript when available. Attach the paths to the hypothesis. Never write log\nfiles directly.\n\n### 3. Validate before writing\n\nReopen every cited source or rerun the cited command:\n\n- citation and excerpt match exactly;\n- the excerpt contains enough surrounding lines to establish context;\n- command evidence records the exact command and observed output;\n- relevance accurately says whether the item supports or contradicts;\n- no cited evidence was fabricated, stale, or outside the requested scope.\n\nStore accepted evidence with `[correct]`; retain rejected evidence only when\nuseful, marked `[incorrect]` with the validation reason. Never adjudicate from an\nunvalidated item.\n\n### 4. Adjudicate\n\nFor each updated node:\n\n- `confirmed`: validated evidence establishes the statement and withstands\n  relevant contradiction;\n- `wrong`: validated evidence refutes it;\n- `uncertain`: evidence remains mixed or insufficient;\n- leave `open` only when the child could not run or return usable evidence.\n\nWhen an unresolved fact can be answered empirically but not by this local\ninvestigation, create a `researches` item instead of a user question. Link it to\nthe defect and hypothesis, append `researches:<research-id>` to the hypothesis,\nset the node `uncertain`, and park that branch.\n\nCreate a user question only for a requirements/preference choice or information\nthe user alone can supply, such as unavailable credentials or an irreproducible\nexternal event. Never ask whether to fix a confirmed fault.\n\n### 5. Confirmed cause\n\nWhen the validated tree establishes a root cause:\n\n1. Update the defect's `rootCause` with the cited causal chain and set\n   `suggestedFix` to the smallest general correction.\n2. Set defect status to `root-caused`.\n3. Reuse a nonterminal goal already linked through `defects:<defect-id>`;\n   otherwise create a coordination milestone and a defect-seeded goal in\n   `planning`, carrying the cause, correction boundary, regression expectations,\n   and `sourceRefs: [\"defects:<defect-id>\"]`.\n4. Ensure the defect and goal link in both directions.\n5. Stop. Do not run the planner/reviewer loop here.\n\nWhen this command runs standalone, create one open question pointing the user to\n`CQ::plan/advance <goal-id>`. When chained from plan flow, omit that question;\nthe parent resumes planning automatically.\n\nIf the evidence rules out every viable branch without establishing a cause, set\nthe defect `inconclusive` with a precise account of what remains unknown.\n\n## Stop conditions\n\nStop this invocation when any condition holds:\n\n- the defect reached `root-caused`, `inconclusive`, `resolved`, or `wontfix`;\n- every unresolved branch waits on an open question or active research;\n- the round produced no new validated evidence and no justified child;\n- the same blocked state recurs without a new lead;\n- a required external capability remains unavailable.\n\nThere is no fixed depth, child-count, or time cap. The bound is progress.\n\n## Handoff and report\n\nWhen standalone, write one `handoffs` item with `flow: \"investigate\"`, links to\nthe defect, hypotheses, research, goal, and questions, and one of:\n\n- `drained`: cause confirmed or investigation conclusively exhausted;\n- `answers-required`: open requirements question;\n- `user-action-required`: specific unavailable external action;\n- `illness-detected`: actionable state remained but no legal progress occurred.\n\nSuppress this handoff when chained by another CQ command.\n\nReport the defect status, hypotheses created/adjudicated, validated evidence,\nprobe/research activity, the confirmed cause or remaining uncertainty, the\ndefect-seeded goal, and the exact next action.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "research",
    name: "/cq:research",
    kind: "orchestrator",
    source: "commands/cq/research.md",
    description: "Create or resume an empirical research item, then run one research round.",
    inputs: [
  "free-text empirical question or existing research id"
],
    outputs: [
  "new/resumed research, inline research round, and one outer handoff"
],
    ioSchema: [
  "research lifecycle: open -> wip -> concluded|inconclusive; abandonment is user-initiated"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:ledger-response-contract}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"free-text empirical question or existing research id\"\noutputs:\n  - \"new/resumed research, inline research round, and one outer handoff\"\nioSchema:\n  - \"research lifecycle: open -> wip -> concluded|inconclusive; abandonment is user-initiated\"\n```\n\nUse research only for unknowns answerable by evidence or experiment. A\nrequirements, policy, scope, or preference choice belongs in a user question\ninstead.\n\nIf `$ARGUMENTS` names an existing research item, fetch it with full projection.\nReject missing or terminal (`concluded`/`abandoned`) items; resume `open`,\n`wip`, or `inconclusive`.\n\nFor free text:\n\n1. Recheck empirical-versus-user triage.\n2. Search active researches by key terms and resume a matching item instead of\n   duplicating it.\n3. Derive an optional bounded scope from the supplied context.\n4. Create a `Research: <short slug>` coordination milestone.\n5. Create an `open` research item with the complete question and optional\n   scope.\n\nRun `CQ::research/advance <researchId>` inline. It owns hypotheses, explorers,\nexperiments, evidence validation, adjudication, synthesis, and child logs.\nSuppress its handoff because this wrapper writes one using the research-advance\nmapping.\n\nReport whether the research was created or resumed, its milestone/scope, and\nthe complete round outcome. Resume later with research advance directly.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "research/advance",
    name: "/cq:research:advance",
    kind: "orchestrator",
    source: "commands/cq/research/advance.md",
    description: "Advance one research round: extend the hypothesis tree, gather and validate evidence, adjudicate nodes, and conclude or park the research.",
    inputs: [
  "research id ($ARGUMENTS first token)",
  "full research item, linked questions, and hypothesis tree"
],
    outputs: [
  "hypothesis nodes and validated evidence",
  "research status and, when concluded, findings/conclusion/recommendation plus a cited synthesis log",
  "standalone handoff"
],
    ioSchema: [
  "one idempotent, resumable research round per invocation",
  "explorer result: {hypothesisId, evidence[], lean, notes?, probeRequest?}",
  "experimenter result: {hypothesisId, evidence[], lean, notes?}"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n{{cq:fragment:ledger-response-contract}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"research id ($ARGUMENTS first token)\"\n  - \"full research item, linked questions, and hypothesis tree\"\noutputs:\n  - \"hypothesis nodes and validated evidence\"\n  - \"research status and, when concluded, findings/conclusion/recommendation plus a cited synthesis log\"\n  - \"standalone handoff\"\nioSchema:\n  - \"one idempotent, resumable research round per invocation\"\n  - \"explorer result: {hypothesisId, evidence[], lean, notes?, probeRequest?}\"\n  - \"experimenter result: {hypothesisId, evidence[], lean, notes?}\"\n```\n\nYou orchestrate one research round for the research id in `$ARGUMENTS`. You own\nthe hypothesis tree, citation validation, adjudication, and ledger writes.\nChildren only gather evidence; they never adjudicate or mutate the ledger.\n\n{{cq:fragment:subagent-dispatch}}\n\n## Invariants\n\n- Re-derive state from the ledger. Each round must dispatch a child or make a\n  state-changing write. Stop after two consecutive read-only passes.\n- Move `researches` from `open` to `wip` before doing research. Only `wip` may\n  transition to `concluded` or `inconclusive`. Never set `abandoned`.\n- Hypotheses use `open | uncertain | confirmed | wrong`,\n  `parentHypothesis` for ancestry, and `ledgerRefs:\n  [\"researches:<researchId>\"]`. Store only revalidated evidence, prefixed\n  `[correct]` or `[incorrect]`.\n- Dispatch disjoint root hypotheses in parallel. Drill a branch serially\n  because each child depends on validated parent evidence.\n- Resolve `tiers.frontier` once with\n  `ledger::get_config(\"tiers\")`. Pass its model token verbatim.\n  If unavailable, inherit the current model; never invent one.\n- Persist each child summary and available raw transcript through `cq log put`,\n  attach their logical paths in the same item update as the evidence, and never\n  expose capabilities or secrets. Do not write research artifacts into the\n  working tree.\n\n## Round\n\n### 1. Read and gate\n\nFetch the research with full projection. Find its hypothesis nodes and linked\nquestions by exact `ledgerRefs` membership. Reconstruct ancestry from\n`parentHypothesis`.\n\nIf a linked question remains `open`, stop: the round waits for the user. Fold\nanswers from `answered` questions into later framing. If a confirmed node\nalready answers the research but synthesis was interrupted, resume at\nConclusion.\n\nOtherwise set an `open` research to `wip` before continuing.\n\n### 2. Extend the tree\n\nCreate one root hypothesis for each distinct candidate answer not already\nrepresented. When an `uncertain` node needs decomposition, create narrower\nchildren. Prefer the most promising uncertain branch; seed several roots\ntogether only when they are independent. Use the research item's milestone.\n\n### 3. Gather evidence\n\nDispatch `research-explorer` for each frontier node with:\n\n```json\n{\n  \"hypothesisId\": \"<id>\",\n  \"statement\": \"<verbatim hypothesis>\",\n  \"branchContext\": \"<research question, ancestry, validated sibling evidence, and adjudication target>\",\n  \"leads\": [\"<optional file, symbol, query, or URL>\"]\n}\n```\n\nExplorers read repository and external authoritative sources. They return\nevidence with citations and may request a probe when observation alone cannot\nsettle the hypothesis.\n\nFor a warranted `probeRequest`, dispatch `research-experimenter` in a\nthrowaway worktree with the request, hypothesis, branch context, and base\ncommit. Network access and worktree-local dependency installation are allowed.\nThe experimenter may execute probes but must not persist changes outside the\nworktree or request another probe. Harvest its evidence, then remove the\nworktree.\n\nTreat malformed child output as a contract breach. Do not accept partial data.\n\n### 4. Validate and adjudicate\n\nIndependently reopen every cited repository location, retrieve every cited\nexternal source, or rerun every cited command. Mark an item `[correct]` only\nwhen the source matches the excerpt, carries adequate authority, and bears on\nthe hypothesis; otherwise mark it `[incorrect]`.\n\nUpdate each hypothesis once with accumulated evidence, child log paths, and:\n\n- `confirmed` when correct evidence establishes it;\n- `wrong` when correct evidence rules it out;\n- `uncertain` when further decomposition can decide it;\n- `open` when no usable evidence returned.\n\nAdjudicate from `[correct]` evidence only. Then:\n\n- if confirmed nodes answer the research, conclude;\n- if no branch remains adjudicable, set the research `inconclusive` and ask\n  the user only when a genuine user-controlled input could unblock it;\n- otherwise leave the research `wip` for another round.\n\n### 5. Conclusion\n\nWhen the question has an evidence-supported answer, update the research to\n`concluded` with:\n\n- `findings`: the validated evidence narrative and citations;\n- `conclusion`: the direct answer;\n- `recommendation`: the resulting action, if any;\n- all round `sessionLogs` and available `rawLogs`.\n\nCompose the full cited synthesis—question, adjudicated tree, evidence, and\nexcerpts—and route it through `cq log put` to\n`logs/<timestamp>-research-<researchId>.md`. Record the returned logical path in\n`sessionLogs`. Never create this artifact in the repository.\n\n### 6. User input\n\nCreate an `open` question linked to the research only for:\n\n- a requirements or preference choice that changes the question's meaning;\n- unavailable data, hardware, credentials, or external access required for a\n  decisive probe.\n\nDo not ask whether research should continue, whether scope feels large, or\nwhether the user wants to abandon it. Narrow broad questions to an answerable\ncore. Leave the tree intact and stop after filing the question.\n\n## Report and handoff\n\nReport nodes created or adjudicated, experiments run, citation validation\ncounts, research status, conclusion and synthesis path, and any blocking\nquestion. Say another round is warranted when open or uncertain nodes remain.\n\nWhen invoked standalone, write exactly one append-only `handoffs` item:\n\n- `drained`: concluded or no branch remains;\n- `answers-required`: blocked by open questions;\n- `user-action-required`: a named item requires a specific external action\n  only the user can perform;\n- `mixed`: more than one of the above;\n- `illness-detected`: a protocol or invariant failure prevents progress.\n\nSet `flow: \"research\"`, relevant `ledgerRefs`, required\n`blockingQuestions`/`handoffReasons`, and this round's log paths. Do not write a\nhandoff for an ordinary context-window interruption; durable ledger state is\nthe resume point. Never use effort, elapsed time, or remaining work size as a\nstop condition.\n\nWhen invoked inline by another flow, suppress this handoff; the outermost\ncommand owns it.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "implement/start",
    name: "/cq:implement:start",
    kind: "orchestrator",
    source: "commands/cq/implement/start.md",
    description: "Resolve implementation scope, validate the initial task DAG, and run the implementation advance loop.",
    inputs: [
  "optional milestone ids; empty selects every active milestone with non-terminal tasks"
],
    outputs: [
  "scope/ready-set report, inline implementation run, and one outer handoff"
],
    ioSchema: [
  "bootstrap only; implement advance owns execution and suppresses its nested handoff"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"optional milestone ids; empty selects every active milestone with non-terminal tasks\"\noutputs:\n  - \"scope/ready-set report, inline implementation run, and one outer handoff\"\nioSchema:\n  - \"bootstrap only; implement advance owns execution and suppresses its nested handoff\"\n```\n\nWith explicit ids, validate that every milestone exists and is active. Without\nids, select all active milestones containing non-terminal tasks. Do not ask for\nscope, branch, or cadence confirmation; the current branch is the integration\ntarget and the run continues until drained or genuinely blocked.\n\nRead tasks, task dependencies, milestone dependencies, and linked questions.\nReport target ids, task counts, and the initial ready set. A target with no\nready task may remain included while other targets progress.\n\nRun `CQ::implement/advance` inline for the resolved set. It owns worktrees,\ndispatch, review, correction, questions, verification, merge-back, logs, and\nthe final execution report. Suppress its handoff because this wrapper writes\none using the implement-advance mapping.\n\nAfter user answers unblock tasks, resume with implement advance directly; the\nbootstrap need not run again.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "implement/advance",
    name: "/cq:implement:advance",
    kind: "orchestrator",
    source: "commands/cq/implement/advance.md",
    description: "Advance implementation: dispatch DAG-ready tasks in isolated worktrees, review and correct them, then merge verified commits in dependency order.",
    inputs: [
  "optional milestone ids; empty resumes all active milestones with non-terminal tasks",
  "full task state, dependencies, linked questions, worktrees, and reviewer configuration"
],
    outputs: [
  "task transitions, one terminal review per task, verified fast-forward merges, defect closure, and milestone archival",
  "standalone handoff"
],
    ioSchema: [
  "worker: {taskId,status,resultCommit,branch,filesTouched,checkSummary,gateDurationMs,summary,blockedReason?}",
  "reviewer: {taskId,verdict,criticism[],questions[],defects[],rationale,summary?}",
  "resolver: {taskId,status,resultCommit?,summary,blockedReason?}"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n\n## Catalogue\n\n```yaml\ninputs:\n  - \"optional milestone ids; empty resumes all active milestones with non-terminal tasks\"\n  - \"full task state, dependencies, linked questions, worktrees, and reviewer configuration\"\noutputs:\n  - \"task transitions, one terminal review per task, verified fast-forward merges, defect closure, and milestone archival\"\n  - \"standalone handoff\"\nioSchema:\n  - \"worker: {taskId,status,resultCommit,branch,filesTouched,checkSummary,gateDurationMs,summary,blockedReason?}\"\n  - \"reviewer: {taskId,verdict,criticism[],questions[],defects[],rationale,summary?}\"\n  - \"resolver: {taskId,status,resultCommit?,summary,blockedReason?}\"\n```\n\nYou orchestrate implementation. Children never mutate the ledger or merge.\nRe-derive state on every invocation. A pass must dispatch a child, mutate the\nledger, or merge; stop after two consecutive read-only passes.\n\n{{cq:fragment:subagent-dispatch}}\n{{cq:fragment:implement-dispatch-workflow}}\n\n## Shared rules\n\n- Resolve `tiers` and `reviewers` once per pass with\n  `ledger::get_config(\"tiers\")` and `ledger::get_config(\"reviewers\")`.\n  Workers use their task's `suggestedModel`; reviewers and conflict resolvers\n  use `tiers.frontier`. Pass configured model aliases verbatim. If a tier is\n  absent, inherit the current model and report the missing configuration.\n- Run at most eight workers concurrently. Each task uses an isolated worktree\n  and branch `implement/<taskId>`.\n- Persist every child summary and available raw transcript with `cq log put`,\n  attach their logical paths to the affected ledger item, and never expose\n  capabilities or secrets.\n- The surface-specific fragment defines dispatch input delivery and result\n  materialization. Retain the parent-prepared handle. Interpret a native\n  result only after the exact retained handle yields `state: \"consumed\"`.\n  Never inspect a body-returning completion or trust a child-reported handle.\n- A missing or non-consumed native result is a LOST REPORT. Log it and retry\n  the same role once with a fresh prepared dispatch. A second loss fails that\n  task path closed, leaves the task non-terminal and its worktree intact, and\n  cannot become a worker failure, reviewer abstention, or resolver verdict.\n\n## 1. Derive the ready set\n\nRead each target milestone and its full task items, linked questions, milestone\ndependencies, and referenced dependency items.\n\nBefore dispatch, prune stale worktree metadata and inspect all implementation\nand runtime-created worktrees. Never touch the main checkout, the ledger backup\nbranch, a worktree for a `wip`/`blocked` task, or an unmerged worktree without a\nterminal task association. Remove a worktree and branch only when its branch\nhas merged into the base or its associated task is `done`/`abandoned`.\n\nChange a `blocked` task back to `planned` after all linked questions become\n`answered`; include the answers in its next dispatch.\n\nA task is ready when:\n\n- its status is `planned`;\n- it has no open linked question;\n- every resolvable `dependsOn` item has a satisfying status declared by its\n  ledger (`tasks:done`, `defects:resolved`, `questions:answered`, and analogous\n  configured sets);\n- every prerequisite milestone has all tasks terminal.\n\nTerminal-but-unsatisfying statuses such as `abandoned` and `wontfix` do not\nsatisfy dependencies. Advisory or unresolvable free-text references do.\n\nIf no task is ready and no task awaits review or merge, report and stop.\n\n## 2. Dispatch workers\n\nBefore each initial or criticism-round dispatch, resolve the intended base with\n`git rev-parse --verify` and require `git cat-file -t` to return `commit`.\nAfter preparing or reusing the worktree, resolve its authoritative tip with\n`git -C <worktree> rev-parse --verify HEAD`, retain it as `startingCommit`, and\nrequire `git -C <worktree> cat-file -t <startingCommit>` to return `commit` plus\n`git merge-base --is-ancestor <verifiedBaseCommit> <startingCommit>` to exit\nzero. Immediately before prepare and again before launch, require the current\nworktree `HEAD` to equal that retained `startingCommit`. Retain the exact\n`baseCommit`, `round`, and `startingCommit`; never reconstruct them from a child\nreport.\n\nFor each selected task:\n\n1. If its linked owning goal is `planned`, move it once to `building`. Never\n   move a goal to a terminal status.\n2. Set the task `wip`.\n3. Prepare its worktree and dispatch `implement-worker` with the exact task\n   specification, worktree coordinates, verified base, required `round`,\n   authoritative `startingCommit`, and any prior criticism.\n4. Materialize only a consumed, schema-valid result through the dispatch\n   protocol. Before accepting a passing result, require its `resultCommit` to be\n   a commit, the worker branch tip to equal it, and\n   `git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.\n\nDo not symlink another checkout's `node_modules`; the worker installs its own\nworkspace dependencies.\n\n## 3. Review\n\nBefore any review dispatch, require\n`git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.\nReview each passing worker result against the actual `baseCommit..resultCommit`\ndiff, acceptance criteria, and gate evidence. A worker failure enters the\ncriticism loop using `blockedReason`.\n\nIf reviewers are unconfigured, dispatch one native `implement-reviewer`. If\nconfigured, dispatch the panel concurrently. Native reviewers use the\nsurface-specific dispatch protocol. External reviewers run through their\nconfigured non-interactive adapter and the shared implement-review rubric.\n\n**External reviewer usable-verdict rule.** Fence-strip and validate stdout\nfirst. A complete, parseable verdict counts as a vote despite a non-zero shell\nexit; log that exit anomaly. Require full-object validation before accepting the\nverdict. Only a returned external failure without such a verdict, empty output,\nmalformed result, or off-enum verdict abstains and must be logged.\n\n**External reviewer no-timeout rule.** Do not impose a silent timeout.\nFence-strip and validate stdout first. A complete, parseable verdict counts as a\nvote despite a non-zero shell exit; log that exit anomaly. A non-zero exit\ncauses abstention only when no complete, parseable, fully validated verdict\nexists; a genuinely stalled adapter remains an operational failure. If every\nconfigured reviewer abstains, use one native reviewer; zero successful\nreviewers can never approve a task.\n\nReconcile surviving reviews in configured order:\n\n- any `disapprove` wins; all must approve and the gate must be green for\n  `approve`;\n- union and source-tag `criticism`, `questions`, and `defects`, deduplicating\n  equivalent entries;\n- `approve` requires empty criticism/questions;\n- `disapprove` requires at least one criticism or question.\n\nFile each out-of-scope or pre-existing `defects[]` entry once as an open defect\nlinked to the task and owning goal. Such defects do not block the current task\nand never become user disposition questions.\n\n## 4. Correct or park\n\nWhen the reconciled verdict disapproves with criticism and no questions,\nredispatch the same worker in the same worktree, then review again. There is no\nfixed round cap while evidence shows convergence.\n\nPark the task when:\n\n- the review asks a genuine user-only requirements question;\n- a correction round makes no file change;\n- the same criticism repeats without shrinking across consecutive rounds;\n- the same gate failure signature repeats.\n\nCreate linked open questions with the round history, set the task `blocked`,\nand preserve its worktree. Do not ask the user to decide whether a confirmed\nfault deserves a fix.\n\n## 5. Success authority\n\nA task may merge only when all of these hold:\n\n- its latest worker and required native-reviewer results were consumed through\n  parent-retained handles;\n- the worker reported `REAL_CHECK_EXIT=0`;\n- all surviving reviewers approved with empty criticism/questions;\n- the orchestrator independently verified the exact commit and ancestry.\n\nTreat `gateDurationMs` below `50`, absent/zero, or below one quarter of the\nmedian for earlier rounds of this same task as implausible. Re-run\n`bun run check` in the foreground and use its real exit status. If that cannot\nbe done, fail closed.\n\nBefore rebase and immediately before merge:\n\n1. require `git cat-file -t <resultCommit>` to return `commit`;\n2. require the worker branch tip to equal `resultCommit`;\n3. require `git merge-base --is-ancestor <verifiedBaseCommit> <resultCommit>`\n   to exit zero;\n4. require `git merge-base --is-ancestor <startingCommit> <resultCommit>` to\n   exit zero.\n\nAny failure is a contract breach and forbids merge-back.\n\n## 6. Merge in DAG order\n\nProcess successful tasks sequentially after their dependencies have landed.\nRebase each branch onto the current base. If the tip changes, the old worker\nresult loses authority: redispatch the worker on the rebased tree, rerun its\ngate and review, and repeat the success checks.\n\nOn conflict, dispatch `implement-conflict-resolver`. Continue only from a\nconsumed `pass` result. On `fail`, create a linked question, set the task\n`blocked`, keep the worktree, and skip its dependants.\n\nAfter the final checks, merge the exact object:\n\n```sh\ngit merge --ff-only <resultCommit>\n```\n\nThen mark the task `done` with `resultCommit`, completion summary, and all\nworker/reviewer log paths in the same update. Remove its worktree, delete its\nderived branch, and prune worktree metadata.\n\nFor each linked defect, collect all fix tasks from the defect's task\ndependencies and reverse task links. When all are `done`, set the defect\n`resolved` with a concise fix summary. A discovered task in `planned`, `wip`,\nor `blocked` prevents resolution; never treat task discovery as task completion.\n\nRecord exactly one terminal `reviews` item per task from the reconciled result:\n`go-ahead` for approval, otherwise `revise`, with source-tagged findings and\nall reviewer log paths.\n\nRe-derive the ready set after every merge and continue until drained.\n\n## 7. Milestones and goals\n\nFor each touched milestone, close and archive it only when every contained item\nis terminal and, for a coordination milestone, its goal is also terminal.\nPerform `update_item(ledger_id: \"milestones\", ..., status: \"done\")` before\n`archive_milestone(...)`.\n\nNever auto-close a goal. When all of a goal's work milestones are archived,\nreport that the user may set the goal to `done`; a later sweep may then archive\nits coordination milestone.\n\n## Report and handoff\n\nReport merged tasks and commits, blocked tasks and question ids, failed paths,\narchived milestones, and goals ready for user closure.\n\nWhen invoked standalone, write exactly one append-only `handoffs` item:\n\n- `drained`: no reachable task remains;\n- `answers-required`: tasks are blocked on open questions;\n- `user-action-required`: a named task needs a specific external action only\n  the user can perform;\n- `mixed`: several stop causes coexist;\n- `illness-detected`: a protocol, merge, or invariant failure prevents\n  progress.\n\nSet `flow: \"implement\"`, relevant `ledgerRefs`, required\n`blockingQuestions`/`handoffReasons`, and pass log paths. Do not write a\nhandoff for an ordinary context-window interruption. Never stop because of\nelapsed effort, task count, or remaining work size.\n\nWhen invoked inline by another flow, suppress this handoff; the outermost\ncommand owns it.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "plan-review",
    name: "/cq:plan-review",
    kind: "orchestrator",
    source: "commands/cq/plan-review.md",
    description: "Portable adversarial plan-review rubric and structured verdict contract.",
    inputs: [
  "goal, grounding, full answered-question history, current plan DAG, and prior reviews"
],
    outputs: [
  "one fenced structured verdict"
],
    ioSchema: [
  "{summary,verdict:go-ahead|revise,new_questions[],criticism[],defects[]}"
],
    promptTemplate: "## Catalogue\n```yaml\ninputs:\n  - \"goal, grounding, full answered-question history, current plan DAG, and prior reviews\"\noutputs:\n  - \"one fenced structured verdict\"\nioSchema:\n  - \"{summary,verdict:go-ahead|revise,new_questions[],criticism[],defects[]}\"\n```\n\nReview the plan against the goal, every answered question, and the actual\nrepository. Judge:\n\n- task granularity and bounded scope;\n- correct milestone/task dependency order;\n- concrete, observable acceptance criteria;\n- grounding in real code and constraints;\n- completeness against the goal.\n\nClassify each finding once:\n\n- `new_questions`: user-only requirements or preferences;\n- `criticism`: plan defects the planner can correct;\n- `defects`: out-of-scope or pre-existing repository faults, independent of\n  the plan verdict.\n\nA discoverable fact is not a user question. A confirmed fault is not a\nfix-versus-ignore question.\n\n```json\n{\n  \"summary\": \"<one-line verdict>\",\n  \"verdict\": \"go-ahead | revise\",\n  \"new_questions\": [\"<user-only question>\"],\n  \"criticism\": [\"<planner-fixable plan defect>\"],\n  \"defects\": [\n    {\n      \"headline\": \"<out-of-scope fault>\",\n      \"severity\": \"low | medium | high | critical\",\n      \"rootCause\": \"<optional>\",\n      \"suggestedFix\": \"<optional>\"\n    }\n  ]\n}\n```\n\n`go-ahead` requires empty question and criticism buckets. `revise` requires at\nleast one. Defects never determine the verdict.\n\nWhen a writer persists `defects` in a review item, validate the complete batch,\nconstruct objects in property order `headline`, `severity`, optional\n`rootCause`, optional `suggestedFix`, and compact-serialize each. Consumers\nmust parse and canonically reconstruct the entire batch before side effects.\n\nWrite nothing. End with the fenced JSON object.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "implement-review",
    name: "/cq:implement-review",
    kind: "orchestrator",
    source: "commands/cq/implement-review.md",
    description: "Portable adversarial implementation-review rubric and structured verdict contract.",
    inputs: [
  "task specification, worktree/branch/base, worker result, round, and prior criticism"
],
    outputs: [
  "one fenced structured verdict"
],
    ioSchema: [
  "{taskId,verdict,criticism[],questions[],defects[],rationale,gateReRan,resultCommitVerified,gateDurationMs?,gateReRanReason?,summary?}"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"task specification, worktree/branch/base, worker result, round, and prior criticism\"\noutputs:\n  - \"one fenced structured verdict\"\nioSchema:\n  - \"{taskId,verdict,criticism[],questions[],defects[],rationale,gateReRan,resultCommitVerified,gateDurationMs?,gateReRanReason?,summary?}\"\n```\n\nReview one implementation against the actual diff and task acceptance. Verify:\n\n- acceptance through its named command, output, or invariant;\n- `resultCommit` exists as a commit and equals the worker branch tip;\n- any rerun `bun run check` uses the foreground process's real status and\n  measured duration;\n- correctness, boundary handling, type safety, and surgical scope;\n- defect-fix reproduction and regression coverage.\n\nClassify each finding once:\n\n- `criticism`: objective defects the worker can fix;\n- `questions`: unresolved user-only requirements or product choices;\n- `defects`: out-of-scope or pre-existing faults for separate work.\n\nDiscoverable facts, scope magnitude, and whether to fix a confirmed fault are\nnot questions.\n\n```json\n{\n  \"taskId\": \"<task id>\",\n  \"verdict\": \"approve | disapprove\",\n  \"criticism\": [\"<worker-fixable defect>\"],\n  \"questions\": [\"<user-only ambiguity>\"],\n  \"defects\": [\n    {\n      \"headline\": \"<out-of-scope fault>\",\n      \"description\": \"<evidence and scope boundary>\",\n      \"severity\": \"low | medium | high | critical\",\n      \"suggestedFix\": \"<optional>\"\n    }\n  ],\n  \"rationale\": \"<decisive evidence>\",\n  \"gateReRan\": true,\n  \"resultCommitVerified\": true,\n  \"gateDurationMs\": 12345,\n  \"summary\": \"<optional one-line verdict>\"\n}\n```\n\nAlways state `gateReRan` and `resultCommitVerified`. Include\n`gateDurationMs` only when the gate ran; otherwise include an optional\n`gateReRanReason`. Approval requires empty criticism/questions, a green gate,\nand verified result commit. Disapproval requires criticism or questions.\nDefects do not control the verdict.\n\nWrite nothing. Give a brief session summary, then end with the fenced object.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "planners",
    name: "/cq:planners",
    kind: "orchestrator",
    source: "commands/cq/planners.md",
    description: "Set a session-only planner panel from aliases or adapter:model tokens.",
    inputs: [
  "natural-language alias list or adapter:model tokens"
],
    outputs: [
  "resolved session-only planner set; no durable write"
],
    ioSchema: [
  "cq.toml aliases take precedence; unknown aliases fail explicitly"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"natural-language alias list or adapter:model tokens\"\noutputs:\n  - \"resolved session-only planner set; no durable write\"\nioSchema:\n  - \"cq.toml aliases take precedence; unknown aliases fail explicitly\"\n```\n\nParse `$ARGUMENTS` into planner aliases/tokens. Resolve named aliases from the\nconfigured `aliases` section, case-insensitively. If alias configuration is\nunavailable, reject aliases explicitly. Accept an explicit `adapter:model`\ntoken verbatim. Report every unknown alias; never silently drop it.\n\nEcho the original instruction, resolution source, ordered alias-to-token\nmapping, and canonical token list. State that the override lives only in the\ncurrent chained run, writes no file or ledger item, and reverts to configured\nplanners—or the orchestrator's native fallback—on a fresh run. The plan\norchestrator uses this in-memory set before consulting planner configuration.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "reviewers",
    name: "/cq:reviewers",
    kind: "orchestrator",
    source: "commands/cq/reviewers.md",
    description: "Set a session-only reviewer panel from aliases or adapter:model tokens.",
    inputs: [
  "natural-language alias list or adapter:model tokens"
],
    outputs: [
  "resolved session-only reviewer set; no durable write"
],
    ioSchema: [
  "cq.toml aliases take precedence; unknown aliases fail explicitly"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"natural-language alias list or adapter:model tokens\"\noutputs:\n  - \"resolved session-only reviewer set; no durable write\"\nioSchema:\n  - \"cq.toml aliases take precedence; unknown aliases fail explicitly\"\n```\n\nParse `$ARGUMENTS` into reviewer aliases/tokens. Resolve named aliases from the\nconfigured `aliases` section, case-insensitively. If alias configuration is\nunavailable, reject aliases explicitly. Accept an explicit `adapter:model`\ntoken verbatim. Report every unknown alias; never silently drop it.\n\nEcho the original instruction, resolution source, ordered alias-to-token\nmapping, and canonical token list. State that the override lives only in the\ncurrent chained run, writes no file or ledger item, and reverts to configured\nreviewers—or the orchestrator's native fallback—on a fresh run. The plan and\nimplement orchestrators use this in-memory set before consulting reviewer\nconfiguration.",
    privilege: "RO",
    exposedTools: "none declared",
  },
];
