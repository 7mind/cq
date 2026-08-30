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
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"goal id\"\n  - \"full goal, answered questions, latest review, current draft, and repository context\"\n  - \"explicit candidate-mode request when participating in a planner panel\"\noutputs:\n  - \"default: one schema-valid PlanStepResult object\"\n  - \"candidate: one schema-valid candidate DAG object\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"no ledger writes in either mode\"\n```\n\nYou plan one goal. Read the ledger and repository without mutating domain\nledgers, and never spawn a child. Produce exactly one structured object matching\nthe selected mode.\n\n## Read state\n\nFetch the goal with full projection. From its coordination milestone, read\ngoal-linked questions and reviews with full projection. Choose the latest\nreview by id ordering. Read `planCurrentDraft` when revising. Incorporate all\nanswered questions and existing grounding.\n\nTriage unknowns by who can answer them:\n\n- a verifiable fact belongs in a `researches` action;\n- a requirements, scope, policy, or preference choice belongs in a `questions`\n  action;\n- discoverable repository facts are your responsibility.\n\nIf both types block planning, ask the requirements questions first.\n\n## Default mode\n\nUse default mode unless the dispatch explicitly requests candidate mode. The\norchestrator already owns a guarded planning claim. Return one state-derived\naction and perform no mutation.\n\nTask waits are orchestrator-owned coordination. Do not add a PlanStepResult\naction for task waits.\n\n```json\n{\n  \"mode\": \"default\",\n  \"action\": \"questions | researches | draft | finalize | awaiting | noop\",\n  \"grounding\": \"<optional repository findings>\",\n  \"questions\": [\n    {\n      \"key\": \"<stable slug>\",\n      \"question\": \"<blocking user choice>\",\n      \"context\": \"<why it blocks>\",\n      \"suggestions\": [\"<option>\"],\n      \"recommendation\": \"<recommended option>\"\n    }\n  ],\n  \"researches\": [\n    {\n      \"key\": \"<stable slug>\",\n      \"question\": \"<empirical question>\",\n      \"scope\": \"<bounded investigation>\"\n    }\n  ],\n  \"manifest\": {\n    \"milestones\": [\n      {\n        \"key\": \"<stable slug>\",\n        \"title\": \"<work milestone>\",\n        \"description\": \"<optional>\",\n        \"dependsOn\": [\n          { \"kind\": \"draft-milestone\", \"key\": \"<milestone key>\" }\n        ]\n      }\n    ],\n    \"tasks\": [\n      {\n        \"key\": \"<stable slug>\",\n        \"milestoneKey\": \"<milestone key>\",\n        \"headline\": \"<imperative task>\",\n        \"description\": \"<implementation scope>\",\n        \"acceptance\": \"<observable verification>\",\n        \"suggestedModel\": \"frontier | standard | fast\",\n        \"ledgerRefs\": [\"goals:<G>\", \"defects:<D>\"],\n        \"sourceRefs\": [\"<provenance ref>\"],\n        \"dependsOn\": [\n          { \"kind\": \"draft-task\", \"key\": \"<task key>\" },\n          { \"kind\": \"ledger\", \"ref\": \"<ledger>:<id>\" }\n        ]\n      }\n    ]\n  },\n  \"finalize\": {\n    \"reviewId\": \"<review id>\",\n    \"decision\": {\n      \"headline\": \"plan review: approved\",\n      \"rationale\": \"<why this review authorizes finalization>\"\n    }\n  },\n  \"defectsToFile\": {\n    \"reviewId\": \"<review id>\",\n    \"defects\": [\n      {\n        \"key\": \"<stable slug>\",\n        \"headline\": \"<fault>\",\n        \"severity\": \"low | medium | high | critical\",\n        \"description\": \"<optional>\",\n        \"rootCause\": \"<optional>\",\n        \"suggestedFix\": \"<optional>\"\n      }\n    ]\n  }\n}\n```\n\nEmit only fields allowed by the selected action:\n\n- `questions`: one or more user-only questions.\n- `researches`: one or more empirical investigations.\n- `draft`: a complete `manifest`; revisions replace the prior draft, so retain\n  every still-valid entry.\n- `finalize`: the latest `go-ahead` review id and a decision.\n- `awaiting`: an open linked question already exists; no payload.\n- `noop`: nothing applies; no payload.\n\n`grounding` and `defectsToFile` remain optional where the schema permits.\nEvery manifest needs at least one milestone and task. Use stable client keys.\nDraft references target keys in the same manifest; ledger references target\nalready persisted items. A research-gated task may depend on a research only\nafter that research exists. Set every task's model tier:\n\n- `frontier` for ambiguous, architectural, or cross-cutting work;\n- `standard` for ordinary nontrivial implementation;\n- `fast` for trivial mechanical work.\n\nAcceptance must name a command, observable result, or invariant. Every task\ndeclares its owning `goals:<G>` reference in `ledgerRefs`. Defect-fix tasks\ncarry their defect ownership in `ledgerRefs`; `sourceRefs` records provenance only.\n\nWhen a task declares an expected failure, follow §6a of the implementation\norchestrator. Forms (a) and (b) use the annotation, live marker, and inventory\nentry; form (c) needs no marker. Plan the fix to replace a marker with a\nsame-titled plain test and remove the annotation and inventory entry. Never\nplan triple co-deletion without that plain test or require a red full gate.\n\n### Choosing the action\n\nUse the first applicable rule:\n\n1. An open linked question exists → `awaiting`.\n2. Missing user choices prevent planning → `questions`.\n3. Only empirical unknowns prevent planning → `researches`.\n4. No unconsumed review and enough context exists → `draft`.\n5. Latest review is `revise` with questions → `questions`.\n6. Latest review is `revise` with criticism only → return a complete revised\n   `draft`.\n7. Latest review is `go-ahead` → `finalize`.\n8. Otherwise → `noop`.\n\nA defect-seeded goal whose description contains the confirmed cause and\nsuggested correction normally needs no clarification; plan the fix directly.\nNever close a goal.\n\n### Review defects\n\nWhen acting on a review, its `defects[]` contains either canonical serialized\ndefect objects or receipts proving the batch was already filed.\n\n- If any receipt exists, omit `defectsToFile`.\n- Otherwise parse the entire batch. Require exact fields, canonical\n  serialization, a non-empty headline, and a valid severity. One invalid entry\n  invalidates the whole batch.\n- For a valid unfiled batch, return `defectsToFile` with that review id and\n  stable client keys.\n\nThese defects remain orthogonal to the review verdict and are handled by the\norchestrator.\n\n## Candidate mode\n\nEnter candidate mode only when explicitly requested as one member of a planner\npanel. Propose a complete DAG; do not emit a PlanStepResult or mutate state. If\nthe goal still needs clarification, return empty arrays and explain why in\n`rationale`.\n\n```json\n{\n  \"mode\": \"candidate\",\n  \"milestones\": [\n    {\n      \"title\": \"<work milestone>\",\n      \"dependsOn\": [\"<other milestone title>\"]\n    }\n  ],\n  \"tasks\": [\n    {\n      \"headline\": \"<imperative task>\",\n      \"description\": \"<implementation scope>\",\n      \"acceptance\": \"<observable verification>\",\n      \"suggestedModel\": \"standard\",\n      \"milestone\": \"<milestone title>\",\n      \"dependsOn\": [\"<other task headline>\", \"<persisted ledger ref>\"],\n      \"ledgerRefs\": [\"goals:<G>\", \"defects:<D>\"]\n    }\n  ],\n  \"rationale\": \"<decomposition and sequencing rationale>\"\n}\n```\n\nReferences to candidate milestones/tasks use their titles/headlines because ids\ndo not exist yet. Persisted ledger references remain literal. Do not invent\nextra fields.\n\n## Output\n\nThe result object must cover the decision, evidence, and blockers. The\norchestrator validates and persists it; do not mutate domain ledgers.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
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
    description: "Adversarial plan reviewer. Returns a structured go-ahead/revise verdict without persisting ledger items.",
    inputs: [
  "goal, full answered-question history, grounding, current draft, and prior reviews"
],
    outputs: [
  "structured verdict; the parent persists any review item"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "go-ahead requires empty question/criticism buckets; revise requires at least one"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"goal, full answered-question history, grounding, current draft, and prior reviews\"\noutputs:\n  - \"structured verdict; the parent persists any review item\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"go-ahead requires empty question/criticism buckets; revise requires at least one\"\n```\n\nReview the complete current plan against the goal, all answered questions, and\nthe actual repository. Apply the shared plan-review rubric. Check scope,\ngrounding, task granularity, dependency order, concrete acceptance, model tiers,\nand completeness.\n\nClassify findings:\n\n- `new_questions`: user-only requirements or preferences;\n- `criticism`: plan defects the planner can correct;\n- `defects`: out-of-scope or pre-existing faults, independent of verdict.\n\nDo not turn discoverable facts or fix-disposition choices into questions.\n\n```json\n{\n  \"summary\": \"<one-line verdict>\",\n  \"verdict\": \"revise\",\n  \"new_questions\": [\"<user-only question>\"],\n  \"criticism\": [\"<planner-fixable defect>\"],\n  \"defects\": [\n    {\n      \"headline\": \"<fault>\",\n      \"severity\": \"medium\",\n      \"rootCause\": \"<optional>\",\n      \"suggestedFix\": \"<optional>\"\n    }\n  ]\n}\n```\n\n`go-ahead` requires empty `new_questions` and `criticism`; `revise` requires at\nleast one. `defects` never controls the verdict.\n\nDo not create a review item; return the identical structured verdict. The parent owns review\npersistence in both configured-panel and unconfigured fallback modes.\nEncode each defect as compact canonical JSON with property order\n`headline`, `severity`, optional `rootCause`, optional `suggestedFix`; keep the\nreturned objects structured. Never return a review-id pointer instead of the\nobject.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
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
  "task specification, optional advisory worktreePath, branch, verified full-SHA base, required round, authoritative starting commit, optional priorResultCommit, optional prior criticism, optional server-injected guarded-rebase lineage"
],
    outputs: [
  "one verified task commit, parent-verifiable git receipts, actualWorktreePath, required baseVerification evidence, green legacy or trusted supervised gate evidence, stored structured result, and handle-only final reply"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "pass requires a green full gate (in-child on legacy dispatches; trusted result-storage supervision on brokered process dispatches), verified commit/clean tree/ancestry, required actualWorktreePath, verified baseVerification (full SHAs only), and required mutation evidence",
  "fail may carry verified or unresolvable baseVerification with a closed reason and null SHAs where unobserved"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n\n```yaml\ninputs:\n  - \"task specification, optional advisory worktreePath, branch, verified full-SHA base, required round, authoritative starting commit, optional priorResultCommit, optional prior criticism, optional server-injected guarded-rebase lineage\"\noutputs:\n  - \"one verified task commit, parent-verifiable git receipts, actualWorktreePath, required baseVerification evidence, green legacy or trusted supervised gate evidence, stored structured result, and handle-only final reply\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"pass requires a green full gate (in-child on legacy dispatches; trusted result-storage supervision on brokered process dispatches), verified commit/clean tree/ancestry, required actualWorktreePath, verified baseVerification (full SHAs only), and required mutation evidence\"\n  - \"fail may carry verified or unresolvable baseVerification with a closed reason and null SHAs where unobserved\"\n```\n\nImplement exactly one task. Never mutate the ledger, merge, push, rebase, or\nspawn a child. Work only inside the supplied worktree and task branch. Do not\noperate on another checkout or alter its refs. Report a stale or unusable base\ninstead of improvising cross-checkout repair.\n\nThe orchestrator owns install, worktree create/remove, reset, rebase, symlink,\nand cleanup through its managed prepare/release path. Do not install workspace\ndependencies, create or remove worktrees, symlink `node_modules`, hard-reset,\nrebase, or run worktree lifecycle commands yourself.\n\n### Dispatch input delivery (Claude)\n\nThe launch prompt carries only\n`{ attestationId, generation, inputCapability }`. Before reading or changing\nthe repository, call the ledger MCP `fetch_dispatch_input` tool exactly once\nwith those three fields. Treat its returned `input` as the task specification\ndescribed below. A missing capability, failed retrieval, or second retrieval is\na protocol failure: stop and return `status: \"fail\"` rather than reading task\nnarrative from the ledger or improvising it from the compact launch reference.\n\n\nTreat the resolved task headline, description, and acceptance as the\nspecification. Address every supplied prior criticism. `round` is required on\nevery dispatch (zero-based). Never invent a round; never reset or rebase away\nprior-round commits when `round > 0`.\n\nThe protected inherited receipt prefix is never placed in fetched input. Report\nin `gitReceipts` only the fresh receipts returned by this generation's\n`git_commit` calls. The server reconstructs and validates the complete durable\nchain. Do not replay or synthesize a Git effect merely to reproduce a prior\ngeneration's receipt. `filesTouched` must equal the sorted\n`git diff --name-only <baseCommit>..<resultCommit>` set.\n\nWhen fetched input carries `guardedRebaseLineage`, the dispatch is a\nguarded-rebase continuation: the server resolved the opaque\n`guardedRebase` reference against a terminal durable journal and verified the\nbridge. The lineage binds `oldResultCommit` (the exact terminal pre-rebase\nworker result), `ontoCommit`, `rebasedStartCommit`, and the server-resolved\n`exactTip` mode. On this arm `baseCommit` equals `ontoCommit`, `startingCommit`\nequals `rebasedStartCommit`, the result reports the lineage verbatim as\n`gitLineage`, `gitReceipts` carries ONLY this lineage's fresh post-rebase\nsuffix (never a pre-rebase receipt), and `filesTouched` equals the sorted\n`git diff --name-only <ontoCommit>..<resultCommit>` set rather than a receipt\npath union.\n\n## Procedure\n\n1. **Step 0 — verify prepared evidence only (no install, no lifecycle).**\n   Resolve `actualWorktreePath` with `git rev-parse --show-toplevel` (absolute)\n   first. When the input carries advisory `worktreePath`, prefer that path when\n   it is reachable and is a git worktree of this repository. On a surface with\n   native worktree confinement the only enterable placement is under\n   `.claude/worktrees/` of the session repository. If the supplied path is\n   outside that root, or every attempt to enter it is refused, STOP and return\n   `fail` with a precise `blockedReason` containing the literal diagnosis\n   `worktreePath unreachable from my confined worktree (expected under .claude/worktrees/)`\n   plus the supplied path and the resolved toplevel — do not rediscover the\n   confinement by trial-and-error across sibling checkouts. When the surface\n   adapter already pinned a harness-minted worktree and the advisory path is\n   absent or unusable for that reason, continue in the pinned tree and still\n   report its absolute toplevel as `actualWorktreePath`. Always include\n   `actualWorktreePath` in the stored result.\n\n   Verify placement evidence:\n   - current branch matches the dispatched `branch` (`git rev-parse --abbrev-ref HEAD`);\n   - `git rev-parse HEAD` equals `startingCommit` (full SHA);\n   - `git cat-file -t <baseCommit>` returns `commit` and `baseCommit` is a full\n     40-hex SHA;\n   - `git merge-base --is-ancestor <baseCommit> HEAD` exits zero.\n\n   When `round > 0`, also verify `priorResultCommit` when supplied (non-null):\n   require it to be a full SHA commit object equal to or an ancestor of `HEAD`.\n   Never hard-reset or rebase away from prior criticism commits.\n\n   On a guarded-rebase continuation (the fetched input carries\n   `guardedRebaseLineage`) Step 0 instead requires `baseCommit` to equal the\n   lineage `ontoCommit` and `HEAD` to equal both `startingCommit` and the\n   lineage `rebasedStartCommit`. On the initial bridge round\n   `priorResultCommit` must equal the bound `oldResultCommit` exactly; that\n   equality is the ONLY ancestry exemption — the pre-rebase result does not\n   descend from the rewritten `HEAD` and must not be claimed to. Any later\n   correction round's `priorResultCommit` is again equal to or an ancestor of\n   `HEAD`. Record `baseVerification` with `baseCommit` set to `ontoCommit`.\n\n   On any mismatch STOP immediately with `status: \"fail\"`, a precise\n   `blockedReason`, and `baseVerification` set to the matching unresolvable arm\n   (`path-mismatch` | `branch-mismatch` | `starting-commit-mismatch` |\n   `prior-result-commit-mismatch` | `base-missing` | `base-not-commit` |\n   `head-missing` | `head-not-commit` | `unrelated-histories` |\n   `ancestry-unobserved`) with full SHAs or `null` — never a fabricated SHA.\n   On success record\n   `baseVerification: { status: \"verified\", relation: \"equal\"|\"descendant\",\n   baseCommit, headCommit }` using full object SHAs only. These checks apply to\n   every initial and criticism round. Never reset away prior task commits.\n\n2. **Implement surgically.**\n   When the private launch supplies `gitChangeCapability`, all Git mutations go\n   through the dispatch-bound `git_commit` broker. On that path, never run\n   `git add`, `git commit`, `git update-index`, `git update-ref`, or write a Git\n   directory, common directory, ref, index, or object yourself. Read-only Git\n   inspection remains permitted. A surface still on the documented held\n   dispatch protocol follows its existing confined commit path and omits\n   `gitReceipts`; it never invents or requests a capability. For each brokered\n   checkpoint choose a stable\n   `operationId` that survives a lost response, set `expectedHead` to the\n   currently verified task head, and submit the closed manifest of add,\n   modify, delete, or explicit rename entries. Every old/new state contains the\n   authoritative repository-relative path, regular mode `100644` or `100755`,\n   and lowercase SHA-256 digest of the file bytes. Do not submit symlinks,\n   gitlinks, undeclared paths, inferred renames, or a manifest assembled before\n   the final byte/mode measurement. Retry a lost response with the exact same\n   operation id and request; retain the returned receipt verbatim in\n   `gitReceipts`. A broker-capable passing result reports this generation's\n   fresh receipt suffix in commit order; it may be empty when this generation\n   performed no Git effect and protected prior receipts already form the\n   complete chain. A changed request requires a new\n   operation id.\n\n   **Early skeleton write (load-bearing durability).** The first substantive\n   action after grounding and base verification MUST be to create a durable\n   partial artifact and persist it through the applicable commit path, even\n   when nearly empty.Prefer\n   `WIP-<taskId>.md` in the worktree root using the existing WIP partial format\n   (fenced JSON header with `taskId`, `role`, `baseCommit`, `startedAt`, and a\n   non-empty `checkpoints[]` of `{name,status}` where status is\n   `done | todo | unmeasured`, followed by\n   `## <name> <!-- cq:wip-checkpoint -->` body sections). Mark unfinished work\n   `todo` or `unmeasured` rather than omitting it so a harvested partial is\n   self-describing. For the parent-owned supervised full gate, use the exact\n   task-local checkpoint name `trusted full gate` with status `unmeasured`.\n   Preserve that checkpoint's status `unmeasured` until trusted finalization;\n   synonyms such as `full-gate` do not qualify. A committed partial is worth\n   more than an uncommitted complete deliverable. Do not defer the first write\n   until the end of the turn.\n   The early WIP-skeleton commit and non-empty new-receipt requirement have two\n   no-effect exemptions. First, a correction round (`round > 0`) with no\n   repository change remaining reports `resultCommit === startingCommit` and\n   an empty fresh suffix; the server accepts it only when a protected prior\n   receipt chain already reaches that exact tip. Second, the server-resolved\n   exact-tip mode of a guarded-rebase continuation\n   (`guardedRebaseLineage.exactTip === true`) likewise reports\n   `resultCommit === rebasedStartCommit`, an empty fresh suffix, and performs no\n   `git_commit` call. Never synthesize a commit solely to avoid an empty suffix.\n   Any correction that advances the tip keeps early persistence and a\n   non-empty contiguous fresh suffix.\n   **Incremental persistence.** Reproduce a defect before correcting it. Match\n   project conventions and do not repair unrelated faults. At natural\n   checkpoints — after each measurement, probe, acceptance clause, or\n   non-trivial edit batch — update the WIP artifact (or the real deliverable)\n   and persist it through the applicable commit path. Keep checkpoint statuses\n   honest (`done` / `todo` / `unmeasured`).\n   Never couple durability to completion of the whole task.\n\n3. **Prove changed guards.** For every test, assertion, guard, or invariant you\n   add or change, deliberately make it fail, capture the expected failure,\n   restore the intended bytes, and capture the pass. Hash affected files before\n   mutation and after restoration. Report only observations from this run in\n   `mutationTable`; if evidence is unavailable, report the gap rather than\n   claiming success.\n\n4. **Run targeted checks.** Use exact test paths when discovery matters and\n   record nonzero test counts. Check wrapped prose with a multiline-aware\n   operation.\n\n   **Expected-failure tasks.** A task that declares an expected failure follows\n   §6a of the implementation orchestrator. Forms (a) and (b) carry the required\n   annotation, live marker, and inventory entry; form (c) needs no marker. A fix\n   replaces the marker with a same-titled plain test and removes its annotation\n   and inventory entry. Never use a red full gate as expected-failure evidence.\n\n5. **Obtain a green full gate through the dispatch's trusted path.** When the\n   private launch supplies `gitChangeCapability`, do **not** invoke `cq gate run`\n   inside the sandbox. Finish the commit and verification in Step 6, then\n   call `store_result` without `gateDurationMs` or `supervisedGateEvidence`.\n   A matching `gate-pending` acknowledgement confirms durable handoff to the\n   trusted parent and permits the final response. Do not wait for\n   `result-stored`: the trusted parent starts the gate only after this child\n   exits. If the response is lost, retry only the exact same `store_result`\n   request.\n   The trusted result-storage boundary holds the managed worktree effect lock,\n   verifies the exact clean branch tip and receipt chain, runs the canonical\n   full gate, rechecks the tip and tree, and attaches\n   `supervisedGateEvidence` before the result becomes consumable. A caller must\n   never mint or copy that evidence. A red, zero-test, timed-out, cancelled,\n   dirty, moved-tip, or replayed attempt fails storage and cannot yield\n   `result-stored`.\n\n   On a dispatch without `gitChangeCapability`, run the full gate in the\n   foreground from the worktree root exactly as\n   `cq gate run --worktree \"$PWD\" --command-cwd \"$PWD/nix/pkg/cq-ledgers\" -- bun run check`.\n   A yielded command-session handle remains the sole full-gate attempt. Continue\n   to poll that exact session or explicitly terminate it; after termination,\n   continue polling and require terminal settlement before retrying the gate,\n   calling `store_result`, or returning. Never launch a replacement full-gate\n   attempt while the prior session remains live. Capture start/end time and\n   assign its exit status immediately after the command, independent of any\n   pipe or wrapper. Preserve `REAL_CHECK_EXIT=<n>`, the verbatim result tail,\n   and `gateDurationMs`. Iterate until zero. An unrelated-failure claim requires\n   an A/B reproduction of the same selector and signature on this tree and the\n   recorded base; if confinement prevents that proof, return `fail`.\n\n6. **Commit and verify.** Commit all task changes through the applicable path, then require:\n   - `git rev-parse --verify HEAD` succeeds;\n   - `git cat-file -t <head>` returns `commit`;\n   - `git status --porcelain --untracked-files=all` is empty;\n   - `git merge-base --is-ancestor <baseCommit> HEAD` exits zero.\n     Immediately before constructing the result, rerun\n     `git rev-parse --verify HEAD` and copy its stdout verbatim into\n     `resultCommit`, then require\n     `git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.\n     Rerun `git rev-parse --show-toplevel` and copy its stdout verbatim into\n     `actualWorktreePath`.\n     Keep the Step-0 `baseVerification` verified arm on pass (update\n     `headCommit` to the final tip when it advanced under the same base).\n\n## Result\n\n```json\n{\n  \"taskId\": \"<task id>\",\n  \"status\": \"pass | fail\",\n  \"resultCommit\": \"<verified head, or null on fail>\",\n  \"branch\": \"implement/<taskId>\",\n  \"actualWorktreePath\": \"<absolute git rev-parse --show-toplevel>\",\n  \"filesTouched\": [\"<path>\"],\n  \"gitReceipts\": [{ \"kind\": \"cq-git-change-receipt\", \"version\": 1, \"attestationId\": \"<id>\", \"generation\": 1, \"taskId\": \"<task id>\", \"operationId\": \"<stable id>\", \"requestDigest\": \"<sha256>\", \"oldHead\": \"<commit>\", \"newHead\": \"<commit>\", \"tree\": \"<tree>\", \"objectOids\": [\"<oid>\"], \"paths\": [\"<path>\"], \"committedAt\": \"<utc timestamp>\" }],\n  \"gitLineage\": \"<guarded-rebase continuations only: the exact server-injected lineage object plus kind: \\\"guarded-rebase\\\"; omitted by ordinary workers>\",\n  \"checkSummary\": \"<legacy REAL_CHECK_EXIT plus tail, or trusted-gate delegation summary>\",\n  \"gateDurationMs\": \"<legacy dispatches only>\",\n  \"baseVerification\": {\n    \"status\": \"verified\",\n    \"relation\": \"equal | descendant\",\n    \"baseCommit\": \"<40-hex>\",\n    \"headCommit\": \"<40-hex>\"\n  },\n  \"summary\": \"<what changed, how acceptance was met, and residual risk>\",\n  \"blockedReason\": \"<fail only>\"\n}\n```\n\nThe stored brokered process result contains runner-owned\n`supervisedGateEvidence` instead of caller-supplied `gateDurationMs`; the child\nomits both fields when calling `store_result`.\n\nOn fail with unresolvable base evidence use:\n`baseVerification: { status: \"unresolvable\", reason: \"<closed reason>\",\nbaseCommit: <40-hex|null>, headCommit: <40-hex|null> }` — never invent a SHA.\n\nThe prompt-catalog schema is authoritative, including any conditional\n`mutationTable` requirement. `pass` requires observed gate success, mutation\nevidence where required, a verified commit object, a clean tree, base\nancestry, a reported `actualWorktreePath`, and verified `baseVerification`.\n\nSubmit the object through the dispatch-scoped `store_result` tool. With\n`gitChangeCapability`, only a matching `gate-pending` acknowledgement permits\nthe final response. Without `gitChangeCapability`, only `result-stored` permits\nthe final response. Retry a lost response only with the exact same request. Then reply with the\nprepared dispatch handle only as the exact one-line JSON\n`{\"attestationId\":\"<prepared attestation id>\",\"generation\":<prepared generation>}`\nand nothing else; never return the result body or a capability.",
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
          "minLength": 1,
          "description": "Optional advisory path from worktree_manage prepare. When a surface adapter supplies its own isolated worktree, that one wins (D143). Preferred Claude placement is .claude/worktrees/<taskId>."
        },
        "branch": {
          "type": "string",
          "description": "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
          "pattern": "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$"
        },
        "baseCommit": {
          "type": "string",
          "description": "The commit the worktree was prepared from (full 40-hex object SHA).",
          "pattern": "^[0-9a-f]{40}$"
        },
        "round": {
          "type": "integer",
          "description": "The zero-based implementation or correction round. Required end-to-end; a default of 0 is allowed only during refs-form normalization, never by omitting the field from the final worker input.",
          "minimum": 0
        },
        "startingCommit": {
          "type": "string",
          "description": "The authoritative worktree tip immediately before this round launches.",
          "pattern": "^[0-9a-f]{40}$"
        },
        "priorResultCommit": {
          "type": [
            "string",
            "null"
          ],
          "description": "Prior-round worker resultCommit to revalidate when round > 0 (full SHA or null). Must be equal to or an ancestor of HEAD; the worker must not reset or rebase away from it.",
          "pattern": "^[0-9a-f]{40}$"
        },
        "priorCriticism": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Prior-round reviewer criticism[] on a re-dispatch after review."
        },
        "guardedRebaseLineage": {
          "type": "object",
          "description": "Closed server-injected guarded-rebase bridge (D334/T2150). Callers must omit it; the trusted manager injects it only after resolving the opaque guardedRebase reference against a terminal durable journal and the exact terminal prior generation. The guarded round's baseCommit equals ontoCommit and its startingCommit equals rebasedStartCommit.",
          "properties": {
            "guardedRebase": {
              "type": "string",
              "pattern": "^cq-guarded-rebase:v1:[0-9a-f]{64}$",
              "description": "The resolved opaque digest-backed guarded-rebase reference."
            },
            "oldResultCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$",
              "description": "The exact terminal pre-rebase worker result tip. On the initial bridge round priorResultCommit equals exactly this value — the one exempted ancestry exception."
            },
            "ontoCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$",
              "description": "The exact rebase target; the guarded dispatch's diff base."
            },
            "rebasedStartCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$",
              "description": "The verified terminal rebased head; the guarded round's startingCommit. The fresh receipt suffix begins here."
            },
            "exactTip": {
              "type": "boolean",
              "description": "Server-resolved permission for the no-new-commit arm: when true the worker may report resultCommit == rebasedStartCommit with an empty fresh suffix; when false a non-empty contiguous suffix is mandatory."
            }
          },
          "required": [
            "guardedRebase",
            "oldResultCommit",
            "ontoCommit",
            "rebasedStartCommit",
            "exactTip"
          ],
          "additionalProperties": false
        },
        "resolvedModel": {
          "type": "string",
          "description": "The resolved model class (informational)."
        }
      },
      "required": [
        "taskId",
        "acceptance",
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
        "actualWorktreePath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute path of the worktree the worker actually operated in (git rev-parse --show-toplevel). Required so the orchestrator learns harness-minted paths (D143)."
        },
        "filesTouched": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "gitReceipts": {
          "type": "array",
          "description": "Fresh dispatch-bound broker receipts returned to this worker generation. Both ordinary and guarded correction rounds omit the protected inherited prefix; the server reconstructs and validates the complete durable chain. The suffix may be empty when the generation performs no Git effect; the server rejects an empty complete chain.",
          "items": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "cq-git-change-receipt"
              },
              "version": {
                "type": "integer",
                "const": 1
              },
              "attestationId": {
                "type": "string",
                "minLength": 1
              },
              "generation": {
                "type": "integer",
                "minimum": 1
              },
              "taskId": {
                "type": "string",
                "pattern": "^T[0-9]+$"
              },
              "operationId": {
                "type": "string",
                "minLength": 1
              },
              "requestDigest": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
              },
              "oldHead": {
                "type": "string",
                "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
              },
              "newHead": {
                "type": "string",
                "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
              },
              "tree": {
                "type": "string",
                "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
              },
              "objectOids": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                }
              },
              "paths": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "committedAt": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "kind",
              "version",
              "attestationId",
              "generation",
              "taskId",
              "operationId",
              "requestDigest",
              "oldHead",
              "newHead",
              "tree",
              "objectOids",
              "paths",
              "committedAt"
            ],
            "additionalProperties": false
          }
        },
        "gitLineage": {
          "type": "object",
          "description": "Closed guarded-rebase discriminant (D334/T2150). Omitted by ordinary workers; a guarded worker reports exactly the server-injected lineage coordinates and treats gitReceipts as the fresh post-rebase suffix. A caller can never mint this arm: store_result resolves it against the persisted dispatch Git binding.",
          "properties": {
            "kind": {
              "type": "string",
              "const": "guarded-rebase"
            },
            "guardedRebase": {
              "type": "string",
              "pattern": "^cq-guarded-rebase:v1:[0-9a-f]{64}$"
            },
            "ontoCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$"
            },
            "rebasedStartCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$"
            },
            "exactTip": {
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "guardedRebase",
            "ontoCommit",
            "rebasedStartCommit",
            "exactTip"
          ],
          "additionalProperties": false
        },
        "checkSummary": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "baseVerification": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "string",
                  "const": "verified"
                },
                "relation": {
                  "type": "string",
                  "enum": [
                    "equal",
                    "descendant"
                  ]
                },
                "baseCommit": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{40}$"
                },
                "headCommit": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{40}$"
                }
              },
              "required": [
                "status",
                "relation",
                "baseCommit",
                "headCommit"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "string",
                  "const": "unresolvable"
                },
                "reason": {
                  "type": "string",
                  "enum": [
                    "base-missing",
                    "base-not-commit",
                    "head-missing",
                    "head-not-commit",
                    "unrelated-histories",
                    "ancestry-unobserved",
                    "path-mismatch",
                    "branch-mismatch",
                    "starting-commit-mismatch",
                    "prior-result-commit-mismatch"
                  ]
                },
                "baseCommit": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "pattern": "^[0-9a-f]{40}$"
                },
                "headCommit": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "pattern": "^[0-9a-f]{40}$"
                }
              },
              "required": [
                "status",
                "reason",
                "baseCommit",
                "headCommit"
              ],
              "additionalProperties": false
            }
          ],
          "description": "T1307/G121 Step-0 base evidence. Pass requires the verified full-SHA arm; fail accepts verified or unresolvable with a closed reason and null SHAs where unobserved."
        },
        "blockedReason": {
          "type": "string"
        },
        "gateDurationMs": {
          "type": "integer",
          "minimum": 0,
          "description": "Wall-clock milliseconds `bun run check` took. Required when status is \"pass\"."
        },
        "supervisedGateEvidence": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "cq-supervised-gate-evidence"
            },
            "version": {
              "type": "integer",
              "const": 1
            },
            "attestationId": {
              "type": "string",
              "pattern": "^att_[A-Za-z0-9_-]{32,}$"
            },
            "generation": {
              "type": "integer",
              "minimum": 1
            },
            "roleId": {
              "type": "string",
              "const": "implement-worker"
            },
            "roleVersion": {
              "type": "integer",
              "minimum": 1
            },
            "surface": {
              "type": "string",
              "const": "codex"
            },
            "promptDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "catalogHash": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "inputDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "taskId": {
              "type": "string",
              "pattern": "^T[0-9]+$"
            },
            "worktreePath": {
              "type": "string",
              "minLength": 1
            },
            "branch": {
              "type": "string",
              "pattern": "^implement/T[0-9]+$"
            },
            "baseCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$"
            },
            "startingCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$"
            },
            "resultCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$"
            },
            "clean": {
              "type": "boolean",
              "const": true
            },
            "command": {
              "type": "string",
              "const": "cq gate run --worktree \"$PWD\" --command-cwd \"$PWD/nix/pkg/cq-ledgers\" -- bun run check"
            },
            "gateExitCode": {
              "type": "integer",
              "const": 0
            },
            "passCount": {
              "type": "integer",
              "minimum": 1
            },
            "failCount": {
              "type": "integer",
              "const": 0
            },
            "gateDurationMs": {
              "type": "integer",
              "minimum": 0
            },
            "capturedAt": {
              "type": "string",
              "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$"
            },
            "filesTouchedDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "gitReceiptsDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "mutationTableDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            }
          },
          "required": [
            "kind",
            "version",
            "attestationId",
            "generation",
            "roleId",
            "roleVersion",
            "surface",
            "promptDigest",
            "catalogHash",
            "inputDigest",
            "taskId",
            "worktreePath",
            "branch",
            "baseCommit",
            "startingCommit",
            "resultCommit",
            "clean",
            "command",
            "gateExitCode",
            "passCount",
            "failCount",
            "gateDurationMs",
            "capturedAt",
            "filesTouchedDigest",
            "gitReceiptsDigest",
            "mutationTableDigest"
          ],
          "additionalProperties": false,
          "description": "Runner-owned Codex exact-tip gate evidence. This arm is mutually exclusive with the legacy in-child gateDurationMs arm and is accepted only after store_result resolves it against the prepared dispatch."
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
        "actualWorktreePath",
        "filesTouched",
        "checkSummary",
        "summary",
        "baseVerification"
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
            "oneOf": [
              {
                "required": [
                  "gateDurationMs"
                ],
                "not": {
                  "required": [
                    "supervisedGateEvidence"
                  ]
                }
              },
              {
                "required": [
                  "supervisedGateEvidence"
                ],
                "not": {
                  "required": [
                    "gateDurationMs"
                  ]
                }
              }
            ],
            "properties": {
              "baseVerification": {
                "type": "object",
                "properties": {
                  "status": {
                    "type": "string",
                    "const": "verified"
                  },
                  "relation": {
                    "type": "string",
                    "enum": [
                      "equal",
                      "descendant"
                    ]
                  },
                  "baseCommit": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{40}$"
                  },
                  "headCommit": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{40}$"
                  }
                },
                "required": [
                  "status",
                  "relation",
                  "baseCommit",
                  "headCommit"
                ],
                "additionalProperties": false
              }
            }
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
        },
        {
          "if": {
            "required": [
              "supervisedGateEvidence"
            ]
          },
          "then": {
            "properties": {
              "status": {
                "const": "pass"
              }
            },
            "required": [
              "status"
            ]
          }
        },
        {
          "if": {
            "required": [
              "gitLineage"
            ]
          },
          "then": {
            "required": [
              "gitReceipts"
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
  "task specification, worktree/branch/full-SHA base, worker result, round, prior criticism, optional trusted supervisedGateEvidence or parentGateAttestation, and prepare-bound absolute phase timing"
],
    outputs: [
  "stored structured verdict with resultCommitEvidence + baseAncestry, and handle-only final reply"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "approve requires empty criticism/questions, green gate (verified supervisedGateEvidence, child re-run, or verified parentGateAttestation), resultCommitVerified=true, and verified resultCommitEvidence + baseAncestry (full SHAs)",
  "disapprove may carry unresolvable evidence with closed reasons and nullable observed SHAs"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n### Dispatch input delivery (Claude)\n\nThe launch prompt carries `attestationId`, `generation`, and `inputCapability`.\nBefore reading or changing the repository, call the ledger MCP\n`fetch_dispatch_input` tool exactly once and treat its typed input as the\ncomplete review assignment. A failed or second retrieval is a protocol failure.\n\n\n## Catalogue\n\n```yaml\ninputs:\n  - \"task specification, worktree/branch/full-SHA base, worker result, round, prior criticism, optional trusted supervisedGateEvidence or parentGateAttestation, and prepare-bound absolute phase timing\"\noutputs:\n  - \"stored structured verdict with resultCommitEvidence + baseAncestry, and handle-only final reply\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"approve requires empty criticism/questions, green gate (verified supervisedGateEvidence, child re-run, or verified parentGateAttestation), resultCommitVerified=true, and verified resultCommitEvidence + baseAncestry (full SHAs)\"\n  - \"disapprove may carry unresolvable evidence with closed reasons and nullable observed SHAs\"\n```\n\nReview one task against the actual diff and acceptance. Never edit the\nrepository, mutate the ledger, or spawn a child.\n\nThe fetched input carries `gateCompleteBy`, `responseStoreNow`, and\n`synthesisStoreReserveMs`. These are absolute prepare-bound values. Never\nderive a new phase window from launch, fetch, inspection, verification, or gate\nstart. Launch delay, inspection, result-commit verification, and the canonical\nregistered gate all consume the same window ending at `gateCompleteBy`. Compare\nthe current clock to that instant at each boundary; only `now >=\ngateCompleteBy` exhausts the phase. The interval through `responseStoreNow` is\nreserved exclusively for synthesizing and storing a verdict.\n\n**Result-commit evidence (required).** Independently:\n\n1. Run `git -C <worktree> rev-parse --verify <resultCommit>^{commit}` (or\n   `cat-file -t`) and require object type `commit` with a full 40-hex SHA.\n2. Run `git -C <worktree> rev-parse --verify <branch>` and require its full SHA\n   to equal `resultCommit`.\n3. On success set\n   `resultCommitEvidence: { status: \"verified\", resultCommit, branchTip }` with\n   full SHAs and `resultCommitVerified: true`.\n4. On failure set `resultCommitVerified: false` and\n   `resultCommitEvidence: { status: \"unresolvable\", reason, resultCommit,\n   branchTip }` using a closed reason\n   (`result-commit-missing` | `result-commit-not-commit` |\n   `result-commit-malformed` | `branch-tip-mismatch` | `branch-unresolvable` |\n   `worktree-unresolvable`) and full SHAs or `null` — never invent a SHA.\n\n**Base-ancestry evidence (required).** Independently:\n\n1. Resolve the dispatch `baseCommit` to a full SHA commit object.\n2. Compute `git -C <worktree> merge-base <baseCommit> <resultCommit>`.\n3. Require `git merge-base --is-ancestor <baseCommit> <resultCommit>` to exit\n   zero (base equal to or ancestor of the result).\n4. On success set\n   `baseAncestry: { status: \"verified\", relation: \"equal\"|\"descendant\",\n   baseCommit, resultCommit, mergeBase }` with full SHAs only.\n5. On failure set\n   `baseAncestry: { status: \"unresolvable\", reason, baseCommit, resultCommit,\n   mergeBase }` with a closed reason\n   (`base-missing` | `base-not-commit` | `result-commit-missing` |\n   `result-commit-not-commit` | `merge-base-unobserved` | `not-ancestor` |\n   `unrelated-histories`) and nullable observed values.\n\nDistinguish stale ancestry (`not-ancestor` with both objects present) from\nunresolvable objects (`base-missing`, `*-not-commit`, `merge-base-unobserved`).\nApproval requires both evidence arms verified; never approve with unresolvable\nor missing ancestry.\n\nAlso verify the worktree diff against the claimed `filesTouched` set where\npractical, and verify or re-run the gate as below.\n\n**Gate evidence.** When the fetched input carries `supervisedGateEvidence`,\nrequire its strict versioned schema and verify that its `taskId`,\n`resultCommit`, `branch`, and `worktreePath` exactly match this review input.\nAlso require the canonical command, `gateExitCode === 0`, `failCount === 0`,\n`passCount > 0`, `clean === true`, `roleId === \"implement-worker\"`, and\n`surface === \"codex\"`. Reject caller substitutions or incomplete evidence.\nDo **not** invoke `cq gate run` inside the sandbox. On valid evidence set\n`gateReRan=false`, `gateReRanReason=sandbox-denied-primitives`, omit reviewer\n`gateDurationMs`, and cite the runner-owned counts, command, duration, and\ncapture time in the rationale.\n\nOtherwise, when the fetched input carries `parentGateAttestation` (the legacy\nsandboxed path where gate primitives are denied):\n\n1. Do **not** invoke `cq gate run` inside the sandbox.\n2. Verify the attestation against `workerResult.resultCommit`: require exact\n   `resultCommit` match, `gateExitCode === 0`, `failCount === 0`, and\n   `passCount > 0`. Reject (disapprove) when any predicate fails.\n3. On a valid green attestation set `gateReRan=false`,\n   `gateReRanReason=sandbox-denied-primitives`, omit `gateDurationMs`, and\n   include the attested `gateExitCode` / `passCount` / `failCount` /\n   `command` / optional `gateDurationMs` in `rationale` (or `summary`).\n\nWhen both evidence fields are absent, re-run the gate yourself. Use the\nforeground process's real exit status and measure its duration. Invoke that\ngate as\n`cq gate run --worktree <worktree> --command-cwd <worktree>/nix/pkg/cq-ledgers --deadline <gateCompleteBy> -- bun run check`.\nThe deadline path terminates and settles the registered command before it\nreturns; measure `gateDurationMs` through that termination and settlement.\nNon-sandboxed reviewers always take this child re-run path.\n\nCheck acceptance, correctness, boundary handling, type safety, surgical scope,\nand defect reproduction.\n\nFor a task that declares an expected failure, apply §6a of the implementation\norchestrator. Forms (a) and (b) require the annotation, live marker, and\ninventory entry; form (c) needs no marker. A completed fix replaces the marker\nwith a same-titled plain test and removes the annotation and inventory entry.\nReject co-deletion of that triple when no same-titled plain test remains, and\nnever approve a red full gate.\n\nIf the phase expires before a complete acceptance verdict can be established,\nstore a disapproval before `responseStoreNow` whose sole criticism is exactly\n`Implementation-review phase budget exhausted before a complete acceptance verdict could be established.`\nUse exactly one of these evidence tuples:\n\n- before result-commit verification completes: `resultCommitVerified=false`,\n  `gateReRan=false`, omit `gateDurationMs`, and set `gateReRanReason` to\n  `phase-budget-exhausted-before-result-commit-verification`; carry\n  unresolvable `resultCommitEvidence` / `baseAncestry` with the best observed\n  values;\n- after result-commit verification but before gate start: set\n  `resultCommitVerified=true`, `gateReRan=false`, omit `gateDurationMs`, and set\n  `gateReRanReason` to `phase-budget-exhausted-before-gate-start`;\n- when the registered gate overruns `gateCompleteBy`: set\n  `resultCommitVerified=true`, `gateReRan=true`, set `gateDurationMs` to the\n  measured elapsed time through termination and settlement, and omit\n  `gateReRanReason`.\n\nFor every exhaustion fallback set `questions=[]`, `defects=[]`, and use the\nexact exhaustion sentence as `rationale` as well as the sole criticism. A\ndisapproval with both empty `criticism` and empty `questions` violates the\nsidecar and must never be stored.\n\nClassify each finding once:\n\n- `criticism`: objective defects the worker can fix;\n- `questions`: unresolved user-only requirements or product choices;\n- `defects`: out-of-scope or pre-existing faults for separate work.\n\nDiscoverable facts, cost, scope magnitude, and whether to fix a confirmed fault\nare not questions.\n\n```json\n{\n  \"taskId\": \"<task id>\",\n  \"verdict\": \"approve | disapprove\",\n  \"criticism\": [\"<worker-fixable defect>\"],\n  \"questions\": [\"<user-only ambiguity>\"],\n  \"defects\": [\n    {\n      \"headline\": \"<out-of-scope fault>\",\n      \"description\": \"<evidence and scope boundary>\",\n      \"severity\": \"low | medium | high | critical\",\n      \"suggestedFix\": \"<optional>\"\n    }\n  ],\n  \"rationale\": \"<decisive evidence>\",\n  \"gateReRan\": true,\n  \"resultCommitVerified\": true,\n  \"resultCommitEvidence\": {\n    \"status\": \"verified\",\n    \"resultCommit\": \"<40-hex>\",\n    \"branchTip\": \"<40-hex>\"\n  },\n  \"baseAncestry\": {\n    \"status\": \"verified\",\n    \"relation\": \"equal | descendant\",\n    \"baseCommit\": \"<40-hex>\",\n    \"resultCommit\": \"<40-hex>\",\n    \"mergeBase\": \"<40-hex>\"\n  },\n  \"gateDurationMs\": 12345,\n  \"summary\": \"<optional one-line verdict>\"\n}\n```\n\nAlways state `gateReRan`, `resultCommitVerified`, `resultCommitEvidence`, and\n`baseAncestry`. Include `gateDurationMs` only when the gate ran; otherwise\ninclude an optional `gateReRanReason` (use exactly `sandbox-denied-primitives`\non the parent-attested path). Approval requires empty criticism/questions, a\ngreen gate (child re-run exit 0, or a verified parent attestation with exit 0 /\nfailCount 0 / passCount > 0), `resultCommitVerified=true`, and both evidence\narms verified with full SHAs. Disapproval requires criticism or questions and\nmay carry unresolvable evidence. Defects do not control the verdict.\n\nStore the object exactly once through the dispatch-scoped `store_result` tool. Only a\n`result-stored` acknowledgement permits the final response. Then reply with the\nprepared dispatch handle only; never return the verdict body or a capability.",
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
          "minLength": 1,
          "description": "Optional advisory path. When a surface adapter supplies its own isolated worktree, that one wins (D143)."
        },
        "branch": {
          "type": "string",
          "description": "The task branch name: implement/<taskId>, or a Claude native-isolation worktree-agent-<hex> name (D77).",
          "pattern": "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$"
        },
        "baseCommit": {
          "type": "string",
          "pattern": "^[0-9a-f]{40}$",
          "description": "Dispatch base commit (full 40-hex object SHA) used for ancestry verification."
        },
        "workerResult": {
          "type": "object",
          "properties": {
            "resultCommit": {
              "type": [
                "string",
                "null"
              ],
              "pattern": "^[0-9a-f]{40}$"
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
        },
        "parentGateAttestation": {
          "type": "object",
          "properties": {
            "resultCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$",
              "description": "The commit SHA the parent gate observed (must equal worker resultCommit)."
            },
            "gateExitCode": {
              "type": "integer",
              "description": "Exit status of the parent-run full gate (0 = green)."
            },
            "passCount": {
              "type": "integer",
              "minimum": 0,
              "description": "Number of passing checks observed by the parent gate."
            },
            "failCount": {
              "type": "integer",
              "minimum": 0,
              "description": "Number of failing checks observed by the parent gate."
            },
            "gateDurationMs": {
              "type": "integer",
              "minimum": 0,
              "description": "Optional wall-clock milliseconds the parent gate took."
            },
            "command": {
              "type": "string",
              "minLength": 1,
              "description": "The exact full-gate command the parent ran."
            },
            "capturedAt": {
              "type": "string",
              "minLength": 1,
              "description": "ISO-8601 instant when the parent captured the gate evidence."
            }
          },
          "required": [
            "resultCommit",
            "gateExitCode",
            "passCount",
            "failCount",
            "command",
            "capturedAt"
          ],
          "additionalProperties": false
        },
        "supervisedGateEvidence": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "cq-supervised-gate-evidence"
            },
            "version": {
              "type": "integer",
              "const": 1
            },
            "attestationId": {
              "type": "string",
              "pattern": "^att_[A-Za-z0-9_-]{32,}$"
            },
            "generation": {
              "type": "integer",
              "minimum": 1
            },
            "roleId": {
              "type": "string",
              "const": "implement-worker"
            },
            "roleVersion": {
              "type": "integer",
              "minimum": 1
            },
            "surface": {
              "type": "string",
              "const": "codex"
            },
            "promptDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "catalogHash": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "inputDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "taskId": {
              "type": "string",
              "pattern": "^T[0-9]+$"
            },
            "worktreePath": {
              "type": "string",
              "minLength": 1
            },
            "branch": {
              "type": "string",
              "pattern": "^implement/T[0-9]+$"
            },
            "baseCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$"
            },
            "startingCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$"
            },
            "resultCommit": {
              "type": "string",
              "pattern": "^[0-9a-f]{40}$"
            },
            "clean": {
              "type": "boolean",
              "const": true
            },
            "command": {
              "type": "string",
              "const": "cq gate run --worktree \"$PWD\" --command-cwd \"$PWD/nix/pkg/cq-ledgers\" -- bun run check"
            },
            "gateExitCode": {
              "type": "integer",
              "const": 0
            },
            "passCount": {
              "type": "integer",
              "minimum": 1
            },
            "failCount": {
              "type": "integer",
              "const": 0
            },
            "gateDurationMs": {
              "type": "integer",
              "minimum": 0
            },
            "capturedAt": {
              "type": "string",
              "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$"
            },
            "filesTouchedDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "gitReceiptsDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "mutationTableDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            }
          },
          "required": [
            "kind",
            "version",
            "attestationId",
            "generation",
            "roleId",
            "roleVersion",
            "surface",
            "promptDigest",
            "catalogHash",
            "inputDigest",
            "taskId",
            "worktreePath",
            "branch",
            "baseCommit",
            "startingCommit",
            "resultCommit",
            "clean",
            "command",
            "gateExitCode",
            "passCount",
            "failCount",
            "gateDurationMs",
            "capturedAt",
            "filesTouchedDigest",
            "gitReceiptsDigest",
            "mutationTableDigest"
          ],
          "additionalProperties": false
        },
        "responseStoreNow": {
          "type": "string",
          "minLength": 1,
          "description": "Prepare-bound absolute deadline by which the reviewer must store its verdict."
        },
        "gateCompleteBy": {
          "type": "string",
          "minLength": 1,
          "description": "Prepare-bound absolute deadline for inspection, verification, and gate settlement."
        },
        "synthesisStoreReserveMs": {
          "const": 60000,
          "description": "Reserved interval between gateCompleteBy and responseStoreNow."
        }
      },
      "required": [
        "taskId",
        "acceptance",
        "branch",
        "baseCommit",
        "workerResult",
        "round",
        "responseStoreNow",
        "gateCompleteBy",
        "synthesisStoreReserveMs"
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
          "description": "Whether the reviewer verified the worker's resultCommit sha (cat-file + tip equality) rather than accepting it unchecked."
        },
        "resultCommitEvidence": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "string",
                  "const": "verified"
                },
                "resultCommit": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{40}$"
                },
                "branchTip": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{40}$"
                }
              },
              "required": [
                "status",
                "resultCommit",
                "branchTip"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "string",
                  "const": "unresolvable"
                },
                "reason": {
                  "type": "string",
                  "enum": [
                    "result-commit-missing",
                    "result-commit-not-commit",
                    "result-commit-malformed",
                    "branch-tip-mismatch",
                    "branch-unresolvable",
                    "worktree-unresolvable"
                  ]
                },
                "resultCommit": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "pattern": "^[0-9a-f]{40}$"
                },
                "branchTip": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "pattern": "^[0-9a-f]{40}$"
                }
              },
              "required": [
                "status",
                "reason",
                "resultCommit",
                "branchTip"
              ],
              "additionalProperties": false
            }
          ],
          "description": "T1308 structured result-commit evidence. Approval requires the verified arm (commit object + branch tip equality, full SHAs)."
        },
        "baseAncestry": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "string",
                  "const": "verified"
                },
                "relation": {
                  "type": "string",
                  "enum": [
                    "equal",
                    "descendant"
                  ]
                },
                "baseCommit": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{40}$"
                },
                "resultCommit": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{40}$"
                },
                "mergeBase": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{40}$"
                }
              },
              "required": [
                "status",
                "relation",
                "baseCommit",
                "resultCommit",
                "mergeBase"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "string",
                  "const": "unresolvable"
                },
                "reason": {
                  "type": "string",
                  "enum": [
                    "base-missing",
                    "base-not-commit",
                    "result-commit-missing",
                    "result-commit-not-commit",
                    "merge-base-unobserved",
                    "not-ancestor",
                    "unrelated-histories"
                  ]
                },
                "baseCommit": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "pattern": "^[0-9a-f]{40}$"
                },
                "resultCommit": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "pattern": "^[0-9a-f]{40}$"
                },
                "mergeBase": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "pattern": "^[0-9a-f]{40}$"
                }
              },
              "required": [
                "status",
                "reason",
                "baseCommit",
                "resultCommit",
                "mergeBase"
              ],
              "additionalProperties": false
            }
          ],
          "description": "T1308 structured base-ancestry evidence. Approval requires the verified arm (dispatch base ancestor of resultCommit, exact merge-base full SHA)."
        },
        "gateDurationMs": {
          "type": "integer",
          "minimum": 0,
          "description": "Wall-clock milliseconds the reviewer's own re-run of `bun run check` took. Required when gateReRan is true."
        },
        "gateReRanReason": {
          "type": "string",
          "description": "Optional free-text explanation for why the gate was not re-run, when gateReRan is false."
        },
        "actualWorktreePath": {
          "type": "string",
          "minLength": 1,
          "description": "Optional absolute path of the worktree the reviewer actually inspected (D143)."
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
        "resultCommitVerified",
        "resultCommitEvidence",
        "baseAncestry"
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
        },
        {
          "if": {
            "properties": {
              "verdict": {
                "const": "disapprove"
              }
            },
            "required": [
              "verdict"
            ]
          },
          "then": {
            "anyOf": [
              {
                "properties": {
                  "criticism": {
                    "minItems": 1
                  }
                },
                "required": [
                  "criticism"
                ]
              },
              {
                "properties": {
                  "questions": {
                    "minItems": 1
                  }
                },
                "required": [
                  "questions"
                ]
              }
            ]
          }
        },
        {
          "if": {
            "properties": {
              "verdict": {
                "const": "approve"
              }
            },
            "required": [
              "verdict"
            ]
          },
          "then": {
            "properties": {
              "resultCommitVerified": {
                "const": true
              },
              "resultCommitEvidence": {
                "type": "object",
                "properties": {
                  "status": {
                    "type": "string",
                    "const": "verified"
                  },
                  "resultCommit": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{40}$"
                  },
                  "branchTip": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{40}$"
                  }
                },
                "required": [
                  "status",
                  "resultCommit",
                  "branchTip"
                ],
                "additionalProperties": false
              },
              "baseAncestry": {
                "type": "object",
                "properties": {
                  "status": {
                    "type": "string",
                    "const": "verified"
                  },
                  "relation": {
                    "type": "string",
                    "enum": [
                      "equal",
                      "descendant"
                    ]
                  },
                  "baseCommit": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{40}$"
                  },
                  "resultCommit": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{40}$"
                  },
                  "mergeBase": {
                    "type": "string",
                    "pattern": "^[0-9a-f]{40}$"
                  }
                },
                "required": [
                  "status",
                  "relation",
                  "baseCommit",
                  "resultCommit",
                  "mergeBase"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "resultCommitVerified",
              "resultCommitEvidence",
              "baseAncestry"
            ]
          }
        }
      ]
    },
  },
  {
    id: "implementation-auditor",
    name: "implementation-auditor",
    kind: "agent-subagent",
    source: "agents/implementation-auditor.md",
    description: "Read-only auditor for one trusted packaged historical implementation record.",
    inputs: [
  "one server-assembled packaged audit record binding task, owner goal, exact finalized manifest, optional historical review, commits, retained head, diff, acceptance, gates, roster, and required observations"
],
    outputs: [
  "one strict approve/disapprove audit verdict with an exact observation inventory"
],
    ioSchema: [
  "typed input/output contract: see implementation-auditor in the prompt catalog"
],
    promptTemplate: "### Dispatch input delivery (Claude)\n\nThe launch prompt carries `attestationId`, `generation`, and `inputCapability`.\nBefore inspecting the historical record, call the ledger MCP\n`fetch_dispatch_input` tool exactly once and treat its typed input as the\ncomplete audit assignment. A failed or second retrieval is a protocol failure.\n\n\n## Catalogue\n\n```yaml\ninputs:\n  - \"one server-assembled packaged audit record binding task, owner goal, exact finalized manifest, optional historical review, commits, retained head, diff, acceptance, gates, roster, and required observations\"\noutputs:\n  - \"one strict approve/disapprove audit verdict with an exact observation inventory\"\nioSchema:\n  - \"typed input/output contract: see implementation-auditor in the prompt catalog\"\n```\n\nAudit exactly the fetched historical record. Never edit a repository, mutate a\nledger, spawn a child, or treat prose as authority. The input is assembled by\nthe trusted audit registry; it is not an ordinary implement-reviewer worktree\ncontract and intentionally contains no worker worktree or caller-authored\nevidence object.\n\nIndependently verify every name in `requiredObservations` against the bound\nmanifest, commits, retained repository head, diff, acceptance, gate\nobservations, and optional authenticated historical review. Return each name\nexactly once and in the supplied order. Mark an observation `verified` only\nwhen the supplied immutable observations establish it; otherwise mark it\n`not-verified` and explain the missing or contradictory fact.\n\nApproval requires the exact task, manifest digest, base commit, result commit,\nand repository head from the input, empty criticism and questions, and every\nrequired observation verified. A disapproval requires criticism or questions.\nDo not invent Git objects, gate results, reviews, task membership, or archive\nfacts.\n\nStore the verdict exactly once through the dispatch-scoped `resultCapability`\nusing `store_result`. Only a `result-stored` acknowledgement permits the final\nresponse. Then return the prepared dispatch handle only.",
    privilege: "RO",
    exposedTools: "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Agent",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/implementation-auditor/input",
      "title": "implementation-auditor input",
      "type": "object",
      "$defs": {
        "jsonValue": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "boolean"
            },
            {
              "type": "number"
            },
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/$defs/jsonValue"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/$defs/jsonValue"
              }
            }
          ]
        }
      },
      "properties": {
        "manifestId": {
          "type": "string",
          "minLength": 1
        },
        "manifestDigest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "recordKey": {
          "type": "string",
          "minLength": 1
        },
        "taskId": {
          "type": "string",
          "pattern": "^T[0-9]+$"
        },
        "taskRef": {
          "type": "string",
          "pattern": "^tasks:T[0-9]+$"
        },
        "ownerGoalRef": {
          "type": "string",
          "pattern": "^goals:G[0-9]+$"
        },
        "finalizedManifest": {
          "type": "string",
          "minLength": 1
        },
        "historicalReview": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "$ref": "#/$defs/jsonValue"
            }
          ]
        },
        "baseCommit": {
          "type": "string",
          "pattern": "^[0-9a-f]{40}$"
        },
        "resultCommit": {
          "type": "string",
          "pattern": "^[0-9a-f]{40}$"
        },
        "repositoryHead": {
          "type": "string",
          "pattern": "^[0-9a-f]{40}$"
        },
        "diff": {
          "type": "string"
        },
        "acceptance": {
          "$ref": "#/$defs/jsonValue"
        },
        "gateObservations": {
          "$ref": "#/$defs/jsonValue"
        },
        "auditRoster": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "alias": {
                "type": "string",
                "minLength": 1
              },
              "harness": {
                "type": "string",
                "minLength": 1
              },
              "model": {
                "type": "string",
                "minLength": 1
              },
              "provider": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "effort": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "launch": {
                "type": "string",
                "enum": [
                  "native",
                  "adapter"
                ]
              },
              "adapterId": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "alias",
              "harness",
              "model",
              "provider",
              "launch",
              "adapterId"
            ],
            "additionalProperties": false
          }
        },
        "requiredObservations": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "required": [
        "manifestId",
        "manifestDigest",
        "recordKey",
        "taskId",
        "taskRef",
        "ownerGoalRef",
        "finalizedManifest",
        "historicalReview",
        "baseCommit",
        "resultCommit",
        "repositoryHead",
        "diff",
        "acceptance",
        "gateObservations",
        "auditRoster",
        "requiredObservations"
      ],
      "additionalProperties": false
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/implementation-auditor/output",
      "title": "implementation-auditor verdict",
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
            "type": "string",
            "minLength": 1
          }
        },
        "questions": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "observations": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "minLength": 1
              },
              "status": {
                "type": "string",
                "enum": [
                  "verified",
                  "not-verified"
                ]
              },
              "detail": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "name",
              "status",
              "detail"
            ],
            "additionalProperties": false
          }
        },
        "rationale": {
          "type": "string",
          "minLength": 1
        },
        "manifestDigest": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "baseCommit": {
          "type": "string",
          "pattern": "^[0-9a-f]{40}$"
        },
        "resultCommit": {
          "type": "string",
          "pattern": "^[0-9a-f]{40}$"
        },
        "repositoryHead": {
          "type": "string",
          "pattern": "^[0-9a-f]{40}$"
        }
      },
      "required": [
        "taskId",
        "verdict",
        "criticism",
        "questions",
        "observations",
        "rationale",
        "manifestDigest",
        "baseCommit",
        "resultCommit",
        "repositoryHead"
      ],
      "additionalProperties": false,
      "allOf": [
        {
          "if": {
            "properties": {
              "verdict": {
                "const": "approve"
              }
            },
            "required": [
              "verdict"
            ]
          },
          "then": {
            "properties": {
              "criticism": {
                "maxItems": 0
              },
              "questions": {
                "maxItems": 0
              },
              "observations": {
                "items": {
                  "type": "object",
                  "properties": {
                    "status": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "status"
                  ]
                }
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "verdict": {
                "const": "disapprove"
              }
            },
            "required": [
              "verdict"
            ]
          },
          "then": {
            "anyOf": [
              {
                "properties": {
                  "criticism": {
                    "minItems": 1
                  }
                },
                "required": [
                  "criticism"
                ]
              },
              {
                "properties": {
                  "questions": {
                    "minItems": 1
                  }
                },
                "required": [
                  "questions"
                ]
              }
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
  "task context, conflicted worktree/branch, base commit, conflicting files, parent-observed conflictState, and optional base-side note"
],
    outputs: [
  "stored structured result with durable continuation receipts and handle-only final reply"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "pass requires completed rebase and green full gate"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n### Dispatch input delivery (Claude)\n\nThe launch prompt carries `attestationId`, `generation`, `inputCapability`, and\nthe resolver-only `gitConflictCapability` returned by prepare.\nBefore reading or changing the repository, call the ledger MCP\n`fetch_dispatch_input` tool exactly once and treat its typed input as the\ncomplete conflict-resolution assignment. A failed or second retrieval is a\nprotocol failure. Retain `gitConflictCapability` only for\n`git_resolve_continue`; never print it or store it in a file or result.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"task context, conflicted worktree/branch, base commit, conflicting files, parent-observed conflictState, and optional base-side note\"\noutputs:\n  - \"stored structured result with durable continuation receipts and handle-only final reply\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"pass requires completed rebase and green full gate\"\n```\n\nResolve the supplied rebase conflict inside its worktree. Preserve both the\nalready-merged base behavior and the task's intent. Edit only conflict-related\nfiles. Never run `git add`, `git commit`, `git rebase --continue`, or another\nGit mutation. Declare every resolved path's regular mode and SHA-256 (or\ndeletion) to `git_resolve_continue`, retaining its receipt verbatim. Supply the\nparent's `conflictState` unchanged to the first call. If a receipt returns a\nnext conflict, resolve it and supply only that receipt's exact state to a new\noperation; stop after a terminal receipt. Marker-free resolutions are valid.\nThen run `bun run check` in the worktree foreground. Never push, mutate the\nledger, operate on another checkout, or spawn a child.\n\nIf the intents require task redesign or the gate cannot pass through conflict\nresolution alone, leave the worktree for inspection and return `fail` with a\nprecise reason. A failure still reports the bound branch and absolute worktree\npath plus the complete receipt chain (empty only when no continuation occurred);\nafter a durable step the last receipt must describe the live next conflict.\n\n```json\n{\n  \"taskId\": \"<task id>\",\n  \"status\": \"pass | fail\",\n  \"resultCommit\": \"<rebased tip on pass, otherwise null>\",\n  \"branch\": \"<bound task branch>\",\n  \"actualWorktreePath\": \"<absolute bound worktree path>\",\n  \"filesResolved\": [\"<path>\"],\n  \"conflictReceipts\": [\"<each git_resolve_continue receipt object in order>\"],\n  \"checkSummary\": \"<real gate result and tail>\",\n  \"summary\": \"<how both intents were preserved>\",\n  \"blockedReason\": \"<fail only>\"\n}\n```\n\nStore this object exactly once through the dispatch-scoped `store_result` tool. Only a\n`result-stored` acknowledgement permits the final response. Then reply with the\nprepared dispatch handle only; never return the result body or a capability.",
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
          "minLength": 1,
          "description": "Optional advisory path. When a surface adapter supplies its own isolated worktree, that one wins (D143)."
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
        },
        "conflictState": {
          "type": "object",
          "properties": {
            "baseCommit": {
              "type": "string",
              "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
            },
            "currentHead": {
              "type": "string",
              "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
            },
            "expectedAncestry": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "ancestor": {
                    "type": "string",
                    "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                  },
                  "descendant": {
                    "type": "string",
                    "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                  }
                },
                "required": [
                  "ancestor",
                  "descendant"
                ],
                "additionalProperties": false
              }
            },
            "sequencer": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "rebase-merge"
                },
                "identity": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
                },
                "headName": {
                  "type": "string",
                  "minLength": 1
                },
                "originalTip": {
                  "type": "string",
                  "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                },
                "onto": {
                  "type": "string",
                  "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                },
                "stoppedCommit": {
                  "type": "string",
                  "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                },
                "currentCommand": {
                  "type": "string",
                  "minLength": 1
                },
                "todoDigest": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
                },
                "doneDigest": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
                }
              },
              "required": [
                "kind",
                "identity",
                "headName",
                "originalTip",
                "onto",
                "stoppedCommit",
                "currentCommand",
                "todoDigest",
                "doneDigest"
              ],
              "additionalProperties": false
            },
            "conflicts": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "stage": {
                    "type": "integer",
                    "enum": [
                      1,
                      2,
                      3
                    ]
                  },
                  "mode": {
                    "type": "string",
                    "pattern": "^[0-9]{6}$"
                  },
                  "oid": {
                    "type": "string",
                    "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                  }
                },
                "required": [
                  "path",
                  "stage",
                  "mode",
                  "oid"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "baseCommit",
            "currentHead",
            "expectedAncestry",
            "sequencer",
            "conflicts"
          ],
          "additionalProperties": false,
          "description": "Complete parent-observed rebase transaction supplied unchanged to the first git_resolve_continue call."
        }
      },
      "required": [
        "taskId",
        "branch",
        "baseCommit",
        "conflictingFiles",
        "conflictState"
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
          ],
          "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
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
        },
        "actualWorktreePath": {
          "type": "string",
          "minLength": 1,
          "description": "Absolute path of the worktree the resolver actually operated in (D143)."
        },
        "branch": {
          "type": "string",
          "pattern": "^(implement/T[0-9]+|worktree-agent-[0-9a-f]+)$"
        },
        "conflictReceipts": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/conflictReceipt"
          },
          "description": "Complete durable git_resolve_continue receipt chain when the dispatch carries the resolver capability."
        }
      },
      "required": [
        "taskId",
        "status",
        "resultCommit",
        "filesResolved",
        "checkSummary",
        "summary",
        "actualWorktreePath",
        "branch",
        "conflictReceipts"
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
            "properties": {
              "resultCommit": {
                "type": "string",
                "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
              },
              "conflictReceipts": {
                "type": "array",
                "minItems": 1
              }
            },
            "not": {
              "required": [
                "blockedReason"
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "fail"
              }
            },
            "required": [
              "status"
            ]
          },
          "then": {
            "properties": {
              "resultCommit": {
                "type": "null"
              }
            },
            "required": [
              "blockedReason"
            ]
          }
        }
      ],
      "$defs": {
        "rebaseState": {
          "type": "object",
          "properties": {
            "baseCommit": {
              "type": "string",
              "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
            },
            "currentHead": {
              "type": "string",
              "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
            },
            "expectedAncestry": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "ancestor": {
                    "type": "string",
                    "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                  },
                  "descendant": {
                    "type": "string",
                    "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                  }
                },
                "required": [
                  "ancestor",
                  "descendant"
                ],
                "additionalProperties": false
              }
            },
            "sequencer": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "rebase-merge"
                },
                "identity": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
                },
                "headName": {
                  "type": "string",
                  "minLength": 1
                },
                "originalTip": {
                  "type": "string",
                  "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                },
                "onto": {
                  "type": "string",
                  "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                },
                "stoppedCommit": {
                  "type": "string",
                  "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                },
                "currentCommand": {
                  "type": "string",
                  "minLength": 1
                },
                "todoDigest": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
                },
                "doneDigest": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
                }
              },
              "required": [
                "kind",
                "identity",
                "headName",
                "originalTip",
                "onto",
                "stoppedCommit",
                "currentCommand",
                "todoDigest",
                "doneDigest"
              ],
              "additionalProperties": false
            },
            "conflicts": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "stage": {
                    "type": "integer",
                    "enum": [
                      1,
                      2,
                      3
                    ]
                  },
                  "mode": {
                    "type": "string",
                    "pattern": "^[0-9]{6}$"
                  },
                  "oid": {
                    "type": "string",
                    "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                  }
                },
                "required": [
                  "path",
                  "stage",
                  "mode",
                  "oid"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "baseCommit",
            "currentHead",
            "expectedAncestry",
            "sequencer",
            "conflicts"
          ],
          "additionalProperties": false
        },
        "conflictReceipt": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "cq-git-conflict-continuation-receipt"
            },
            "version": {
              "type": "integer",
              "const": 1
            },
            "attestationId": {
              "type": "string",
              "minLength": 1
            },
            "generation": {
              "type": "integer",
              "minimum": 1
            },
            "taskId": {
              "type": "string",
              "pattern": "^T[0-9]+$"
            },
            "operationId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_-]{1,128}$"
            },
            "requestDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "oldHead": {
              "type": "string",
              "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
            },
            "newHead": {
              "type": "string",
              "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
            },
            "objectOids": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
              }
            },
            "paths": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1
              }
            },
            "outcome": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "terminal"
                    },
                    "tip": {
                      "type": "string",
                      "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                    }
                  },
                  "required": [
                    "kind",
                    "tip"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "conflict"
                    },
                    "tip": {
                      "type": "string",
                      "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                    },
                    "state": {
                      "$ref": "#/$defs/rebaseState"
                    }
                  },
                  "required": [
                    "kind",
                    "tip",
                    "state"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "continuedAt": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "kind",
            "version",
            "attestationId",
            "generation",
            "taskId",
            "operationId",
            "requestDigest",
            "oldHead",
            "newHead",
            "objectOids",
            "paths",
            "outcome",
            "continuedAt"
          ],
          "additionalProperties": false
        }
      }
    },
  },
  {
    id: "investigate-explorer",
    name: "investigate-explorer",
    kind: "agent-subagent",
    source: "agents/investigate-explorer.md",
    description: "Read-only investigator that gathers cited evidence for one causal hypothesis and requests an isolated probe when execution is necessary.",
    inputs: [
  "owning defect id, hypothesis id, verbatim statement, defect/branch context, and optional leads"
],
    outputs: [
  "structured evidence result"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "read-only; no ledger mutation, repository edit, dynamic execution, adjudication, or child dispatch; static repository inspection follows the host adapter"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"owning defect id, hypothesis id, verbatim statement, defect/branch context, and optional leads\"\noutputs:\n  - \"structured evidence result\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"read-only; no ledger mutation, repository edit, dynamic execution, adjudication, or child dispatch; static repository inspection follows the host adapter\"\n```\n\nInvestigate one hypothesis. Inspect repository sources and authoritative\nreferences.\n\n## Static repository inspection\n\nUse the harness's dedicated filesystem read and search tools for static\nrepository inspection; shell commands remain prohibited. Mutation, tests,\nbuilds, benchmarks, package execution, shell networking, adjudication, and\nchild dispatch remain prohibited. Dynamic evidence requires the corresponding\nprober or experimenter.\n\n\nDo not mutate state, adjudicate the hypothesis, or spawn a child. When dynamic\nevidence would provide decisive support or contradiction, request an exact\nprobe from the investigate-prober.\n\nFor every evidence item, cite a precise file location or URL, quote a short\nverbatim excerpt, and explain whether it supports or contradicts the statement.\nReturn no citation you did not inspect.\n\n```json\n{\n  \"hypothesisId\": \"<id>\",\n  \"evidence\": [\n    {\n      \"n\": 1,\n      \"citation\": \"<path:line-range or URL>\",\n      \"excerpt\": \"<verbatim excerpt>\",\n      \"relevance\": \"<supports or contradicts, and why>\"\n    }\n  ],\n  \"lean\": \"supports | contradicts | mixed | insufficient\",\n  \"notes\": \"<optional next lead>\",\n  \"probeRequest\": {\n    \"what\": \"<exact commands or test target>\",\n    \"why\": \"<what static inspection cannot determine>\"\n  }\n}\n```\n\nOmit `probeRequest` unless required; when present, set `lean` to\n`insufficient`. An empty evidence array is preferable to fabrication.\n\nThe result object must include the evidence summary.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RO",
    exposedTools: "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Bash, Agent",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/investigate-explorer/input",
      "title": "investigate-explorer input",
      "type": "object",
      "properties": {
        "defectId": {
          "type": "string",
          "description": "The canonical owning defect id (e.g. D3).",
          "pattern": "^D[0-9]+$"
        },
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
        "defectId",
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
  "owning defect id, hypothesis, exact probe request, branch context, worktree, and base commit"
],
    outputs: [
  "structured evidence result"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "worktree-local execution only; no network, dependency installation, ledger mutation, or persisted change"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"owning defect id, hypothesis, exact probe request, branch context, worktree, and base commit\"\noutputs:\n  - \"structured evidence result\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"worktree-local execution only; no network, dependency installation, ledger mutation, or persisted change\"\n```\n\nRun exactly the requested probe inside the supplied throwaway worktree. Verify\nthe base before executing. You may create temporary worktree-local files and\nrun existing tests/builds, but may not use the network, install dependencies,\ncommit, edit the main checkout, mutate the ledger, adjudicate, or spawn a\nchild. Leave no intended source change; the orchestrator discards the worktree.\n\nReturn precise file, URL, or command citations with verbatim excerpts. For a\ncommand result, the citation is the exact command and the excerpt is observed\noutput.\n\n```json\n{\n  \"hypothesisId\": \"<id>\",\n  \"evidence\": [\n    {\n      \"n\": 1,\n      \"citation\": \"<path:line-range, URL, or exact command>\",\n      \"excerpt\": \"<verbatim excerpt or output>\",\n      \"relevance\": \"<supports or contradicts, and why>\"\n    }\n  ],\n  \"lean\": \"supports | contradicts | mixed | insufficient\",\n  \"notes\": \"<optional next lead or unavailable requirement>\"\n}\n```\n\nReturn no `probeRequest`; you are the execution arm. An empty evidence array is\npreferable to an unobserved claim. The result object must include the evidence\nsummary.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RW",
    exposedTools: "Disallowed: Agent; isolation: worktree",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/investigate-prober/input",
      "title": "investigate-prober input",
      "type": "object",
      "properties": {
        "defectId": {
          "type": "string",
          "description": "The canonical owning defect id (e.g. D3).",
          "pattern": "^D[0-9]+$"
        },
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
        "defectId",
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
  "owning research id, hypothesis id, statement, research/branch context, and optional leads"
],
    outputs: [
  "structured evidence result"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "read-only; no ledger mutation, repository edit, dynamic execution, adjudication, or child dispatch; static repository inspection follows the host adapter"
],
    promptTemplate: "> **CQ command notation (Claude).** `CQ::<path>` names the native slash command\n> `/cq:<path>`, with each `/` in `<path>` written as `:`. Preserve any following\n> arguments and treat `$ARGUMENTS` as the current command's user-supplied text.\n\n\n## Catalogue\n```yaml\ninputs:\n  - \"owning research id, hypothesis id, statement, research/branch context, and optional leads\"\noutputs:\n  - \"structured evidence result\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"read-only; no ledger mutation, repository edit, dynamic execution, adjudication, or child dispatch; static repository inspection follows the host adapter\"\n```\n\nResearch one candidate answer. Inspect repository material and authoritative,\ncurrent external sources. Prefer primary sources.\n\n## Static repository inspection\n\nUse the harness's dedicated filesystem read and search tools for static\nrepository inspection; shell commands remain prohibited. Mutation, tests,\nbuilds, benchmarks, package execution, shell networking, adjudication, and\nchild dispatch remain prohibited. Dynamic evidence requires the corresponding\nprober or experimenter.\n\n\nDo not mutate state, adjudicate, or spawn a child. When dynamic evidence would\nsupport or contradict the answer, request an exact experiment from the\nresearch-experimenter.\n\nEvery evidence item needs a precise file location or URL, short verbatim\nexcerpt, and relevance. For external evidence, include authority and date in\nthe relevance. Never cite a source you did not open.\n\n```json\n{\n  \"hypothesisId\": \"<id>\",\n  \"evidence\": [\n    {\n      \"n\": 1,\n      \"citation\": \"<path:line-range or URL>\",\n      \"excerpt\": \"<verbatim excerpt>\",\n      \"relevance\": \"<supports or contradicts, why, and source authority/date>\"\n    }\n  ],\n  \"lean\": \"supports | contradicts | mixed | insufficient\",\n  \"notes\": \"<optional next lead>\",\n  \"probeRequest\": {\n    \"what\": \"<exact experiment, benchmark, build, or test>\",\n    \"why\": \"<what reading cannot determine>\"\n  }\n}\n```\n\nOmit `probeRequest` unless execution is necessary; when present, set `lean` to\n`insufficient`. An empty evidence array is preferable to fabrication. The\nresult object must include the evidence summary.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RO",
    exposedTools: "Disallowed: Write, Edit, MultiEdit, NotebookEdit, Bash, Agent",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/research-explorer/input",
      "title": "research-explorer input",
      "type": "object",
      "properties": {
        "researchId": {
          "type": "string",
          "description": "The canonical owning research id (e.g. RS4).",
          "pattern": "^RS[0-9]+$"
        },
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
        "researchId",
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
  "owning research id, hypothesis, exact probe request, branch context, worktree, and base commit"
],
    outputs: [
  "structured evidence result"
],
    ioSchema: [
  "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)",
  "network and worktree-local installs allowed; no ledger mutation, main-checkout change, commit, or child dispatch"
],
    promptTemplate: "## Catalogue\n```yaml\ninputs:\n  - \"owning research id, hypothesis, exact probe request, branch context, worktree, and base commit\"\noutputs:\n  - \"structured evidence result\"\nioSchema:\n  - \"typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)\"\n  - \"network and worktree-local installs allowed; no ledger mutation, main-checkout change, commit, or child dispatch\"\n```\n\nRun exactly the requested experiment in the supplied discardable worktree.\nVerify the base first. Network access and worktree-local dependency installation\nare allowed when the probe requires them. Confine every write and installation\nto the worktree; do not commit, mutate the ledger or main checkout, adjudicate,\nor spawn a child.\n\nReturn precise file, URL, or command citations with verbatim excerpts. Preserve\nobserved benchmark values and relevant environment details.\n\n```json\n{\n  \"hypothesisId\": \"<id>\",\n  \"evidence\": [\n    {\n      \"n\": 1,\n      \"citation\": \"<path:line-range, URL, or exact command>\",\n      \"excerpt\": \"<verbatim excerpt or output>\",\n      \"relevance\": \"<supports or contradicts, and why>\"\n    }\n  ],\n  \"lean\": \"supports | contradicts | mixed | insufficient\",\n  \"notes\": \"<optional next lead or limitation>\"\n}\n```\n\nReturn no `probeRequest`; report inconclusive execution with\n`lean: \"insufficient\"`. An empty evidence array is preferable to an unobserved\nclaim. The result object must include the evidence summary.\n\n## Result delivery (Claude)\n\nUse the typed assignment supplied by the native child transport. Return the\nrole-defined structured result in one fenced `json` block as the final content.",
    privilege: "RW",
    exposedTools: "Disallowed: Agent; isolation: worktree",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "cq:prompt-catalog/research-experimenter/input",
      "title": "research-experimenter input",
      "type": "object",
      "properties": {
        "researchId": {
          "type": "string",
          "description": "The canonical owning research id (e.g. RS4).",
          "pattern": "^RS[0-9]+$"
        },
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
        "researchId",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:ledger-response-contract}}\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"free-form request containing any mix of capabilities, faults, and empirical questions\"\noutputs:\n  - \"deduplicated flow intakes, one aggregate ambiguity question, one sequencer pass, and a routing report\"\nioSchema:\n  - \"new capability -> goal; existing fault -> defect; empirical unknown -> research; user-only choice -> question\"\n```\n\nSplit `$ARGUMENTS` into independently actionable segments while preserving\ntheir detail. Ask for input if it is empty.\n\n## Route\n\nClassify each segment:\n\n| Meaning | Route |\n| --- | --- |\n| new capability or change | plan |\n| existing incorrect behavior | investigate |\n| empirically answerable unknown | research |\n| user-only requirement/preference or genuinely ambiguous intent | ambiguity question |\n\nDo not ask for routing confirmation when the segment is clear.\n\nSearch the target ledger for each clear segment:\n\n- exact live duplicate: report and skip;\n- clear extension of a live goal: use the `CQ::plan/follow-up` bootstrap;\n- otherwise create a fresh intake through the target command's bootstrap.\n\nCollect all ambiguous segments into one open question beneath one coordination\nmilestone. Include each segment verbatim, its plausible routes, and useful\nsuggestions. Do not intake those segments until answered.\n\n## Intake and advance\n\nBootstrap all clear segments before advancing:\n\n- plan: create the coordination milestone and clarifying goal;\n- goal extension: validate, append scope, link ideas if present, and enter its\n  documented follow-up path;\n- investigate: create the coordination milestone and open defect;\n- research: create the coordination milestone and open research.\n\nDo not run each flow separately. After all intakes, run `CQ::advance` inline\nonce so its predicates advance the entire batch. The sequencer owns the sole\nrun-level handoff and all child logs. If no segment was intaked, skip it.\n\nReport a routing table with a short segment label, item reference, flow, and\nduplicate/ambiguous disposition. Include the ambiguity question and next\naction.\n\nWrite a handoff only when the sequencer did not run and an ambiguity question\nblocks intake: `answers-required`, `flow: \"begin\"`, the question reference, and\n`blockingQuestions`. Exact-duplicate-only requests need no handoff.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:advance-run-guard}}\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n\n```yaml\ninputs:\n  - \"no arguments; current ledger state\"\noutputs:\n  - \"root-caused defects seeded into fix goals\"\n  - \"all actionable investigate, plan, research, and implement work advanced to quiescence\"\n  - \"one run-level handoff and a drained/blocked/mixed report\"\nioSchema:\n  - \"authoritative readiness comes from ledger::derive_predicates\"\n  - \"cycle order: investigate -> seed -> plan -> research -> implement -> investigate re-check\"\n  - \"no fixed iteration cap; stop only after a full no-progress cycle\"\n```\n\nYou are the whole-ledger sequencer. Run the four flow commands INLINE in this\nsession; do not dispatch their agents yourself or duplicate their internal\nlogic. Subcommands suppress standalone handoffs while chained here. Ledger state,\nnot prose output, determines the next action.\n\n## Authoritative state\n\nAt run start and after every stage that may mutate the ledger, call:\n\n```\nledger::derive_predicates()\n```\n\nIt returns:\n\n```json\n{\n  \"pInvestigate\": { \"value\": true, \"items\": [\"<defect-id>\"] },\n  \"pSeed\": { \"value\": true, \"items\": [\"<defect-id>\"] },\n  \"pPlan\": { \"value\": true, \"items\": [\"<goal-id>\"] },\n  \"pResearch\": { \"value\": true, \"items\": [\"<research-id>\"] },\n  \"pImplement\": { \"value\": true, \"items\": [\"<task-id>\"] },\n  \"pOperatorAction\": { \"value\": true, \"items\": [\"<task-id>\"] },\n  \"openQuestionGate\": { \"value\": false, \"items\": [] },\n  \"belowFloor\": { \"value\": false, \"items\": [] },\n  \"planBusy\": { \"value\": false, \"items\": [] },\n  \"goalDrift\": { \"value\": false, \"items\": [] },\n  \"upstreamBlocked\": { \"value\": false, \"items\": [] }\n}\n```\n\nTrust these derived values. `upstreamBlocked` is report-only and never stops\nthe cycle; record third-party package faults on the `upstream` ledger and run\n`CQ::upstream` for filing/recheck. Use `snapshot()` or focused item reads only for\nnarrative needed by the selected action. Never reimplement readiness by scanning\nentire ledgers or parsing a child command's report.\n\n## Cycle\n\nRepeat the following order. Re-read predicates after each numbered stage.\n\n1. **Investigate.** For every id currently returned by `pInvestigate.items`,\n   run `CQ::investigate/advance <defect-id>` INLINE. Continue past one parked\n   defect; another defect may remain actionable.\n\n2. **Seed fixes.** For `pSeed.items`, fetch the full root-caused defects and\n   separate guarded bootstrap-repair blockers from ordinary unowned defects.\n\n   A bootstrap-repair blocker is already owned by a `planned`/`building` goal,\n   blocks that goal's sole active finalized task, and has no live canonical\n   `fix-goal` correction lineage. For each such defect, call `create_item` with\n   `ledger_id: \"goals\"`, `owner_ref: \"defects:<D>\"`,\n   `creation_kind: \"fix-goal\"`, no explicit milestone/id, status `planning`,\n   and correction-specific title, description, and source refs. The guarded\n   bundle returns the same correction goal on exact replay and concurrent\n   claims. Never call ordinary plan follow-up on the blocked goal and never\n   replace or mutate its task, worktree, finalized manifest, dispatch evidence,\n   receipts, or completion journal. If the returned correction lineage is\n   already `done`, resolve the defect; if it is `abandoned`, mark the defect\n   `wontfix`. Until then, its normal plan/implement predicates own progress.\n\n   Process remaining ordinary seed candidates in deterministic chunks of at\n   most five. For each chunk:\n\n   - create one coordination milestone;\n   - create one `goals` item in `planning`, with a title/description covering\n     every defect, `sourceRefs` containing each `defects:<id>`, and enough\n     root-cause/fix context for planning;\n   - append `goals:<new-goal>` to each defect's `ledgerRefs`, preserving existing\n     refs.\n\n   Except for the guarded bootstrap-repair case above, a root-caused defect\n   already owned by a goal must not seed another. Defects below the configured\n   severity floor remain visible through `belowFloor` but do not seed\n   automatically.\n\n3. **Plan.** If `pPlan.value`, run `CQ::plan/advance` INLINE once; that command\n   advances every unlocked planning goal and owns auto-investigation of defects\n   filed during plan review.\n\n4. **Research.** For every id currently returned by `pResearch.items`, run\n   `CQ::research/advance <research-id>` INLINE.\n\n5. **Implement.** If `pImplement.value` or `pOperatorAction.value`, run\n   `CQ::implement/advance` INLINE once. It owns worker dispatch/review/merge for\n   ordinary tasks and the parent-only operator-action lifecycle for\n   `pOperatorAction.items`; an operator action never dispatches a worker.\n\n6. **Re-check investigation.** Re-read predicates and run newly actionable\n   defects before deciding whether the cycle made progress. Planning,\n   research, and implementation can expose new defects.\n\nAfter any ledger mutation, begin another cycle. Do not impose an iteration,\ntime, or token cap.\n\n## Legitimate stops\n\nA full cycle may stop only when it made no ledger progress and one of these\nconditions holds:\n\n- all six actionable predicates are false (`drained`);\n- every remaining actionable branch waits on open requirements questions\n  (`answers-required`);\n- progress requires an operation CQ cannot perform, such as missing credentials,\n  unavailable infrastructure, deployment, or an external manual action\n  (`user-action-required`);\n- both question-gated and external-action-gated branches remain (`mixed`);\n- predicates remain actionable but a complete cycle produces no legal mutation\n  and no legitimate user gate (`illness-detected`).\n\nDo not ask for confirmation between stages. Fix-versus-wontfix, whether a\nconfirmed defect should be fixed, cost, blast radius, public API impact, and\nscope size are not requirements questions. Running this command authorizes\ncontinued in-scope repair. Ask only when the answer changes required behavior or\nprovides otherwise-unavailable external information or authority.\n\n`belowFloor`, `planBusy`, research parking, and `goalDrift` are diagnostic\ncompanions, not reasons by themselves to claim the run drained. Report them when\nthey explain inactive work.\n\n## End-of-run maintenance\n\nAfter quiescence:\n\n1. For each active non-goal milestone whose referenced items are all terminal,\n   mark it `done` and archive it. Never auto-close goals.\n2. Inspect implementation worktrees. Remove only a task worktree when\n   `decideWorktreeSweep` returns `remove`: the tip is an ancestor of the\n   integration base, `git cherry <base> <tip>` reports every commit as\n   patch-equivalent (all `-` lines → `patchEquivalentToLanded`), or the\n   associated task is `done`/`abandoned`. Preserve any worktree carrying novel\n   commits (`git cherry` `+` lines), report it, then prune stale worktree\n   metadata. Never infer safety from a branch name alone.\n3. Make no git commit or push for ledger mutations; the configured ledger\n   backend owns persistence.\n\n## Handoff and report\n\nWrite exactly one `handoffs` item for the whole run:\n\n- `status`: `drained`, `answers-required`, `user-action-required`, `mixed`, or\n  `illness-detected`;\n- `flow`: `advance`;\n- `summary`: stages run, durable ids/statuses changed, and final predicate state;\n- `blockingQuestions`: open question ids when applicable;\n- `handoffReasons`: external actions or illness evidence when applicable;\n- `ledgerRefs`: the affected defects, goals, researches, and tasks.\n\nThen report:\n\n- the terminal category;\n- changes grouped by investigate, seed, plan, research, and implement;\n- required user answers/actions, if any;\n- below-floor, parked, drifted, or preserved-worktree diagnostics;\n- the handoff id.\n\nBefore returning, perform the surface-specific run-guard cleanup stated above.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:subagent-dispatch}}\n{{cq:fragment:ledger-response-contract}}\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"free-text goal description, or one or more idea ids without interleaving\"\noutputs:\n  - \"one coordination milestone and clarifying goal per intake\"\n  - \"bidirectional idea/goal links and planned idea status when idea-seeded\"\n  - \"first guarded planning round and one outer handoff\"\nioSchema:\n  - \"bootstrap only; plan advance owns questions, claims, drafts, reviews, and finalization\"\n```\n\nCreate goals for new capabilities. A report that existing behavior fails belongs\nto investigation instead; do not turn a fault report directly into a goal.\n\n## Parse and deduplicate\n\nAn empty argument requires user input. An idea id is `I` followed by decimal\ndigits. If every whitespace-delimited token matches that grammar, process each\nidea independently. Otherwise treat the entire argument as one free-text\ndescription; do not interleave ids and prose.\n\nFor each prospective goal, search active goals by key terms. If one already\ncovers the scope, report it and skip creation.\n\n## Bootstrap\n\nFor free text:\n\n1. Create a coordination milestone titled `Plan: <short goal>`.\n2. Create a `clarifying` goal beneath it with a short title and the complete\n   description.\n\nCreate or update each idea without `milestone_id`; the server attaches it to `M-AMBIENT`.\nIdeas never attach to work milestones and are not archived with them.\n`ledgerRefs` linking remains independent of milestone attachment.\n\nFor each idea id:\n\n1. Fetch the full idea; report and skip missing ids.\n2. Create the milestone and goal using the idea title and verbatim description.\n3. Merge `ideas:<ideaId>` into the goal's `fields.sourceRefs` and\n   `goals:<goalId>` into the idea's `fields.ledgerRefs`, preserving all entries\n   already stored in both arrays.\n4. Set the idea to `planned`.\n\nThe coordination milestone contains the goal, clarification questions, reviews,\nand approval decision. Draft publication creates separate work milestones.\n\n## First planning round\n\nRun `CQ::plan/advance <goalId>` inline for every new goal. That command owns the\nclaim, planner dispatch, guarded mutation, defect investigation, and child\nlogs. Suppress its handoff because this wrapper writes the single outer record.\nIts defect phase may run `CQ::investigate/advance` inline.\n\nAfter the round, read the goal-linked open questions and report the milestone,\ngoal, source idea when applicable, current phase, questions to answer, and any\ndefect investigation outcome. Tell the user to answer questions in a client and\nrun plan advance again.\n\nWrite one append-only plan handoff using the plan-advance mapping. A normal\nfirst round stops as `answers-required`, linked to the goal with\n`blockingQuestions` and the child log paths. If several goals produce different\nstop causes, use the corresponding aggregate status.\n\nDo not generate questions, mutate managed plan state, publish a draft, or lock\na decision in this command.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:ledger-response-contract}}\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n\n```yaml\ninputs:\n  - \"optional goal id; empty selects every clarifying/planning goal\"\n  - \"full goal, answered questions, current draft, latest review, planner/reviewer configuration\"\noutputs:\n  - \"guarded claim lifecycle, one current draft, one review per round, final executable manifest or a waiting state\"\n  - \"inline investigation of actionable defects filed by the round\"\n  - \"standalone handoff\"\nioSchema:\n  - \"planner result: typed PlanStepResult or candidate DAG\"\n  - \"review result: {summary,verdict,new_questions[],criticism[],defects[]}\"\n  - \"one active fenced claim per goal and one terminal claim operation per round\"\n```\n\nYou orchestrate the planner-reviewer loop. Children do not own guarded plan\nstate. Claim before planner dispatch, keep the claim through draft/review\niterations, and end it only by pause, abandon, or finalize.\n\n{{cq:fragment:subagent-dispatch}}\n\n## Select goals\n\nWith an argument, target that goal. Without one, fetch all active goals and\nselect `clarifying` or `planning`. Never create a goal here. An empty target set\nmeans the flow is drained; autonomous defect seeding belongs to the outer\nadvance command.\n\nAdvance goals independently. A waiting goal does not prevent other targets\nfrom progressing.\n\n## Per-goal loop\n\nEach iteration must dispatch a child or change state. Stop after a terminal\ntoken or two consecutive read-only passes. Terminal tokens are\n`awaiting-answers`, `awaiting-research`, `awaiting-tasks`, `completed`, and\n`noop`.\n\nWhen `CQ::plan/follow-up` transfers an acknowledged active follow-up claim,\nretain its claim id, generation, and fence token and resume at **§2. Resolve\nplanners and dispatch** with that claim. Do not run §1 or mint an initial claim.\nOnly this explicit in-memory transfer bypasses §1; every normal invocation\nstarts at the pre-claim gate.\n\n### 1. Pre-claim gate and claim\n\nRead the goal, exact goal-linked questions/research waits, and\n`fields.waitingTasks`. Consumers never parse goal descriptions for task-wait\nstate.\n\n- An open question → `awaiting-answers`.\n- Any waited research in `open`, `wip`, or `inconclusive` →\n  `awaiting-research`.\n- Any waited task in `planned`, `wip`, or `blocked` → `awaiting-tasks`.\n- A waited task in `done` or `abandoned`, or one missing from the active view\n  because it is absent or archived, does not block planning.\n\nOtherwise mint a fresh request id and secret fence token and call `claim_plan`\nwith `purpose: \"initial\"` and the observed plan generation. Keep the\nacknowledged claim id, generation, and token in memory; never log the token.\n\nTreat claim conflicts as follows:\n\n- active claim: report the goal busy;\n- active research wait: `awaiting-research`;\n- `task-wait-active`: `awaiting-tasks`;\n- stale generation: reread and retry once;\n- terminal/phase conflict: report and skip;\n- request reuse or fence mismatch: stop with an invariant failure.\n\n### 2. Resolve planners and dispatch\n\nRead `ledger::get_config(\"planners\")` once. Honor any session override.\n\n#### Single-planner fallback\n\nDispatch `plan-advance` in default mode with the goal id. It returns one\nschema-valid PlanStepResult and writes nothing. Reject the whole result on any\ncontract failure; never apply a valid prefix.\n\nApply exactly one matching guarded operation using the active claim. Mint a\nfresh operation id for a new intent and reuse it only when retrying the exact\nsame payload after a lost response. Supply `defectsToFile` as the same\noperation's `reviewDefects`.\n\n- `questions` → pause with question drafts; goal returns to `clarifying`;\n  token `awaiting-answers`.\n- `researches` → pause with research drafts; goal remains `planning` with\n  `waitingResearches`; token `awaiting-research`.\n- `draft` → publish the complete manifest; claim stays active; token\n  `review-requested`.\n- `finalize` → finalize the exact current draft using the named go-ahead\n  review and decision; goal becomes `planned`; token `completed`.\n- `awaiting` or `noop` → abandon the claim without effects; corresponding\n  terminal token.\n\nPersist optional grounding on the goal. `release_plan_claim(kind: \"abandon\")`\nuses the public claim id/generation and no fence token; pause, publish, and\nfinalize require the token. On a lost/stale claim, stop instead of reclaiming\nover another round.\n\n#### Configured planner panel\n\nDispatch every configured planner concurrently in candidate mode through its\nconfigured adapter. Each returns the same candidate DAG and writes nothing.\n**Candidate usable-payload rule.** Fence-strip and validate stdout first. A\ncomplete, parseable candidate counts as a usable candidate despite a non-zero\nshell exit; log that exit anomaly. Require full-object validation before\naccepting the candidate. Only empty, unparseable, invalid, or off-contract\ncandidate output abstains and is logged.\n\n**Candidate no-timeout rule.** No wall-clock timeout is imposed. Fence-strip\nand validate stdout first. A complete, parseable candidate counts as a usable\ncandidate despite a non-zero shell exit; log that exit anomaly. A non-zero exit\ncauses abstention only when no complete, parseable, fully validated candidate\nexists; a stalled adapter remains an operational failure rather than a silent\nabstention. If all abstain, use the single-planner fallback under the same\nclaim, excluding each exact adapter identity that returned an\n`operational-abstention`; never retry that unavailable adapter in the fallback.\n\nSynthesize one manifest:\n\n1. choose the candidate with the strongest grounding and decomposition;\n2. fold in distinct milestones, tasks, acceptance criteria, and dependency\n   edges from other candidates;\n3. deduplicate overlaps;\n4. assign stable milestone/task keys and translate title/headline references\n   into typed draft references. Copy every selected candidate task's\n   `ledgerRefs` into the synthesized draft task's `ledgerRefs`, merge them with\n   the mandatory `goals:<goalId>` owner reference, and de-duplicate without\n   moving any entry into `sourceRefs`.\n\nWhen exactly one usable candidate survives, report `UNCONTESTED (1 surviving candidate)` in the run output.\nCarry that planner-synthesis label into the aggregated review record regardless of how many reviews survive.\n\nPublish that complete manifest under the active claim. Empty candidate DAGs\nmean clarification remains necessary: pause with concrete questions when\navailable, otherwise abandon and return `awaiting-answers`.\n\n### 3. Review a published draft\n\nResolve `ledger::get_config(\"reviewers\")` once and honor any session\noverride.\n\n#### Single-reviewer fallback\n\nSnapshot the highest goal-linked review id before dispatch. Dispatch\n`plan-reviewer` in fallback mode. The reviewer returns a structured verdict and writes nothing. The parent writes exactly one review\nlinked to the goal with the verdict status and buckets through `create_item`,\nsupplying `owner_ref: \"goals:<G>\"` and `creation_kind: \"review\"`, and stamps it\nwith the exact current draft identity.\n\nAfter the parent write, require exactly one new goal-linked review above the snapshot.\nValidate the complete returned and persisted verdicts, including canonical\nserialized defect objects, and require equality. Zero/multiple reviews,\nmalformed data, or any mismatch fails the round before log attachment or\ndefect filing.\n\nStamp the recovered review with the exact current draft identity:\n`{goalId, claimId, generation, revision}`.\n\n#### Configured reviewer panel\n\nDispatch all configured reviewers concurrently through their adapters.\n**Configured reviewer wrapper rule.** Standalone non-interactive wrappers may\nfast-fail with a non-zero shell exit. Fence-strip and validate stdout first. A\ncomplete, parseable verdict counts as a vote despite a non-zero shell exit; log\nthat exit anomaly. Do not drop the emitted verdict solely for that exit.\n\nReviewers return structured verdicts and write nothing.\n**Reviewer usable-verdict rule.** Fence-strip and validate stdout first. A\ncomplete, parseable verdict counts as a vote despite a non-zero shell exit; log\nthat exit anomaly. Require full-object validation before accepting the verdict.\nOnly a returned failure without such a verdict, empty/malformed result, or\noff-enum verdict abstains and is logged. If all abstain, use the single-reviewer\nfallback, excluding each exact adapter identity that returned an\n`operational-abstention`. A fallback with zero successful reviewers remains\nfail-closed and cannot approve.\n\nReconcile surviving reviews in configured order:\n\n- any `revise` wins; all must return `go-ahead` for approval;\n- union and source-tag `new_questions`, `criticism`, and structured `defects`;\n- deduplicate only equivalent findings;\n- `revise` requires at least one question or criticism.\n\nWhen exactly one usable review survives, report `UNCONTESTED (1 surviving review)` in the run output and write the same label to the aggregated review record.\n\nWrite exactly one aggregated review linked to the goal and stamp it with the\ncurrent draft identity.\n\nAfter either review path, continue the planner loop. The next planner result\nmust revise, ask questions, or finalize. There is no numeric cap while the\ndraft changes or criticism shrinks. An identical draft and unchanged\ncriticism across consecutive rounds constitutes a non-converging loop.\n\n## Auto-investigate filed defects\n\nAfter a goal's planner loop stops, query the ledger—not child prose—for\ngoal-linked defects in `open`, `wip`, or `inconclusive`. Deduplicate them and\nrun `CQ::investigate/advance` inline once per defect for this planning round.\nSuppress the nested handoff.\n\nDo not let open goal-clarification questions prevent investigation. Do not\nresume planning for a goal still in `clarifying`; a defect-seeded goal already\nin `planning` may resume immediately.\n\nStop the investigate/replan axis when any condition holds:\n\n- the defect already ran once this round;\n- no new confirmed node or correct evidence appeared;\n- a confirmed cause seeded or extended its fix goal;\n- replanning produced no new fix task or repeated the same task set;\n- two consecutive rounds produced no adjudicable evidence.\n\nFor non-converging or genuinely user-blocked cases, create an open question\nlinked to the affected defect and goal. A `root-caused` defect belongs to the\nouter advance command's seed stage, not another investigation pass.\n\nResearch items filed by planning are also driven by the outer advance command.\nThis command records the wait and stops; it does not run research inline.\n\n## Logs, report, and handoff\n\nPersist every child summary and available raw transcript through `cq log put`,\nattach logical paths to the affected item, and never log fence or capability\nsecrets. Before piping a transcript, require `test -s <transcript>` so empty or\nwhitespace-only captures are skipped rather than written.\n\nReport each goal's current phase and next action, waited research ids, finalized\nwork, and each investigated defect's outcome. Never auto-close a goal.\n\nWhen invoked standalone, write one append-only `handoffs` item:\n\n- `drained`: all targets planned/terminal;\n- `answers-required`: open linked questions block progress;\n- `user-action-required`: a named item requires a specific external action\n  only the user can perform;\n- `mixed`: several stop causes coexist;\n- `illness-detected`: a protocol or convergence invariant prevents progress.\n\nSet `flow: \"plan\"`, relevant goal/defect refs, required\n`blockingQuestions`/`handoffReasons`, and round log paths. Do not write a\nhandoff for ordinary context-window interruption. Never stop because of effort,\nelapsed time, or remaining work size.\n\nWhen invoked inline by another flow, suppress this handoff; the outermost\ncommand owns it.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:subagent-dispatch}}\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"target goal id followed by free text or one or more idea ids\"\noutputs:\n  - \"appended scope, optional idea links, follow-up planning round, and one outer handoff\"\nioSchema:\n  - \"terminal goals reject without mutation\"\n  - \"managed goals use the guarded follow-up claim; unmanaged goals use the legacy reopen transitions\"\n```\n\nUse this for added capability scope on an existing `clarifying`, `planning`,\n`planned`, or `building` goal. Existing faults belong to investigation.\n\n## Parse and gate\n\nThe first token is the goal id. An idea id is `I` followed by decimal digits.\nIf every remaining token matches that grammar, use idea mode; otherwise treat\nthe entire remainder as free text. Reject an empty remainder. Fetch the full\ngoal. Missing, `done`, or `abandoned` goals stop without mutation; terminal\ngoals require a new goal.\n\nIn idea mode, fetch each idea, skip missing ids, and use its title and\ndescription as one follow-up section. In free-text mode, use the request\nverbatim. This preparation is read-only: do not update the goal or any idea\nyet.\n\n## Acquire managed authority\n\nInspect `planGeneration` before appending or linking anything.\n\nFor a protocol-managed goal, mint a fresh request id and secret fence token,\nthen call `claim_plan(purpose: \"follow-up\")` with the observed plan generation\nand write provenance. Never log the token. Any rejected claim result exits\nbefore appending scope or mutating the goal or ideas; report its conflict and\nperform no fallback raw transition. This rule covers every rejection,\nincluding a terminal or phase conflict, active claim or implementation,\nresearch wait, stale generation, request reuse, and fence mismatch.\n\nOn acknowledgement, keep the claim id, generation, and fence token in memory.\nThe claim has entered `planning` and superseded the prior unstarted manifest.\nDo not issue a raw status transition for this managed goal.\n\nAn unmanaged goal has no `planGeneration`; it does not use `claim_plan` and\ncontinues through the legacy path below.\n\n## Append and link\n\nReach this section only after a managed follow-up claim was acknowledged or\nthe goal was confirmed unmanaged.\n\nAppend each scope to the existing description without replacing history:\n\n```markdown\n## Follow-up (<date or ordinal>)\n<scope>\n```\n\nCreate or update each idea without `milestone_id`; the server attaches it to `M-AMBIENT`.\nIdeas never attach to work milestones and are not archived with them.\n`ledgerRefs` linking remains independent of milestone attachment.\n\nFor each idea, merge `ideas:<ideaId>` into the goal's `fields.sourceRefs` and\n`goals:<goalId>` into the idea's `fields.ledgerRefs`, preserving all entries\nalready stored in both arrays; then set the idea `planned`.\n\n## Enter planning\n\nFor an unmanaged goal, move `planned` or `building` through `planning` to\n`clarifying`; move `planning` to `clarifying`; leave `clarifying` unchanged.\n\nFor an unmanaged goal now in `clarifying`, run\n`CQ::plan/advance <goalId>` inline. It owns questions, guarded mutations,\ndefect investigation, and child logs. Suppress its handoff.\nIts defect phase may run `CQ::investigate/advance` inline.\n\nFor a managed goal with the acknowledged claim, enter `CQ::plan/advance` at\n**§2. Resolve planners and dispatch** and transfer the in-memory claim id,\ngeneration, and fence token. Do not run its §1 pre-claim gate or request a\nsecond `purpose: \"initial\"` claim. The resumed command owns planner/reviewer\ndispatch and every guarded publish, pause, abandon, or finalize operation under\nthe transferred claim. Suppress its handoff; its defect phase may run\n`CQ::investigate/advance` inline.\n\nReport appended scope, current phase, open question ids, the next plan-advance\naction, and any investigation outcome. Write one outer plan handoff using the\nplan-advance mapping and child log paths. Do not generate questions, publish a\ndraft, or lock a decision here.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"free-text defect description or existing defect id\"\noutputs:\n  - \"new/resumed defect, inline investigation round, and one outer handoff\"\nioSchema:\n  - \"new defects require headline, description, and critical|high|medium|low severity\"\n```\n\nIf `$ARGUMENTS` names an existing defect, fetch it with full projection. Reject\nmissing or terminal items; otherwise resume it.\n\nFor free text:\n\n1. Search active defects by key terms and resume a matching item instead of\n   duplicating it.\n2. Infer severity:\n   - `critical`: security, data loss, crash, or system-wide block;\n   - `high`: major behavior unavailable without workaround;\n   - `medium`: degraded behavior with a workaround;\n   - `low`: cosmetic or narrow edge case.\n   Ask one question only when adjacent tiers remain genuinely ambiguous.\n3. Create an `Investigate: <short slug>` coordination milestone.\n4. Create an `open` defect with a concise headline, complete description, and\n   severity.\n\nRun `CQ::investigate/advance <defectId>` inline. It owns hypotheses, evidence,\nprobes, research escalation, adjudication, goal seeding, and child logs.\nSuppress its handoff because this wrapper writes one using the\ninvestigate-advance mapping.\n\nReport whether the defect was created or resumed, its milestone/severity, and\nthe complete round outcome. Resume later with investigate advance directly.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n{{cq:fragment:subagent-dispatch}}\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"one defect id and its linked hypothesis/question/research state\"\noutputs:\n  - \"validated hypothesis evidence and status changes\"\n  - \"optional execution probes or research escalation\"\n  - \"confirmed root cause, suggested fix, and defect-seeded planning goal\"\nioSchema:\n  - \"one resumable evidence/adjudication round per invocation\"\n  - \"parallel explorers only for independent roots; serial drilling within a branch\"\n  - \"explorer/prober output: {hypothesisId,evidence[],lean,notes?,probeRequest?}\"\n```\n\nYou own the investigation loop for one defect. Explorers and probers gather\nevidence; they never mutate the ledger or adjudicate. Re-derive state from the\nledger on every invocation. A round must dispatch a child or make a durable\nmutation; otherwise stop with a handoff instead of rereading indefinitely.\n\n## State and invariants\n\n1. Fetch the defect with `projection: \"full\"`. Stop on `resolved` or `wontfix`.\n2. Fetch linked hypotheses, questions, and researches with full projection.\n   Reconstruct hypothesis ancestry from `parentHypothesis`; every node must\n   retain `ledgerRefs: [\"defects:<defect-id>\"]`.\n3. An unanswered linked question parks the affected branch. Fold answered text\n   into the next framing.\n4. A hypothesis parked on `researches:<research-id>` remains parked while that\n   research is `open` or `wip`. On `concluded`, use its findings/conclusion as\n   evidence; on `inconclusive` or `abandoned`, resume from the remaining\n   evidence.\n5. Before forming or dispatching hypotheses, move an `open` defect to `wip`.\n   Never attempt the invalid direct transition from `open` to `root-caused`.\n6. Resolve the frontier model once with\n   `ledger::get_config(\"tiers\")`; use the configured frontier model\n   verbatim. If unavailable, inherit the current runtime model. Do not invent a\n   model identifier.\n\n## Round\n\n### 1. Form hypotheses\n\nIf the tree has no actionable node, create a small set of mutually distinct,\nfalsifiable root hypotheses. Otherwise select unresolved leaves whose parents\nhave enough validated evidence to justify drilling. Do not duplicate an\nexisting statement or create children merely to keep the loop active.\n\nEach new hypothesis includes:\n\n- a precise statement;\n- optional `parentHypothesis`;\n- `ledgerRefs: [\"defects:<defect-id>\"]`;\n- `status: \"open\"`.\n\n### 2. Gather evidence\n\nDispatch one `investigate-explorer` per selected node. Independent roots may run\nin parallel; descendants of one branch run serially because later framing\ndepends on earlier evidence.\n\nThe input must contain the canonical `defectId`, hypothesis id and statement,\ndefect/branch context, known sibling or parent findings, and focused leads. The child returns numbered\nevidence with a precise citation, a three-to-five-line verbatim excerpt, a\nrelevance statement, and a non-binding lean.\n\nIf an explorer returns `probeRequest`, dispatch `investigate-prober` with the\nsame context plus `{what, why}` in an isolated throwaway worktree. The prober is\nlocal-only: no network, no persistent main-checkout edits. Harvest its evidence,\nthen remove the worktree. Never execute a probe in the main checkout.\n\nAfter every child returns, persist its summary through `cq log put` and its raw\ntranscript when available. Before piping a transcript, require `test -s\n<transcript>` so empty or whitespace-only captures are skipped rather than\nwritten. Attach the paths to the hypothesis. Never write log files directly.\n\n### 3. Validate before writing\n\nReopen every cited source or rerun the cited command:\n\n- citation and excerpt match exactly;\n- the excerpt contains enough surrounding lines to establish context;\n- command evidence records the exact command and observed output;\n- relevance accurately says whether the item supports or contradicts;\n- no cited evidence was fabricated, stale, or outside the requested scope.\n\nStore accepted evidence with `[correct]`; retain rejected evidence only when\nuseful, marked `[incorrect]` with the validation reason. Never adjudicate from an\nunvalidated item.\n\n### 4. Adjudicate\n\nFor each updated node:\n\n- `confirmed`: validated evidence establishes the statement and withstands\n  relevant contradiction;\n- `wrong`: validated evidence refutes it;\n- `uncertain`: evidence remains mixed or insufficient;\n- leave `open` only when the child could not run or return usable evidence.\n\nWhen an unresolved fact can be answered empirically but not by this local\ninvestigation, create a `researches` item instead of a user question. Link it to\nthe defect and hypothesis, append `researches:<research-id>` to the hypothesis,\nset the node `uncertain`, and park that branch.\n\nCreate a user question only for a requirements/preference choice or information\nthe user alone can supply, such as unavailable credentials or an irreproducible\nexternal event. Never ask whether to fix a confirmed fault.\n\n### 5. Confirmed cause\n\nWhen the validated tree establishes a root cause:\n\n1. Update the defect's `rootCause` with the cited causal chain and set\n   `suggestedFix` to the smallest general correction.\n2. Set defect status to `root-caused`.\n3. Reuse a nonterminal goal already linked through `defects:<defect-id>`;\n   otherwise create a coordination milestone and a defect-seeded goal in\n   `planning`, carrying the cause, correction boundary, regression expectations,\n   and `sourceRefs: [\"defects:<defect-id>\"]`.\n4. Ensure the defect and goal link in both directions.\n5. Stop. Do not run the planner/reviewer loop here.\n\nWhen this command runs standalone, create one open question pointing the user to\n`CQ::plan/advance <goal-id>`. When chained from plan flow, omit that question;\nthe parent resumes planning automatically.\n\nIf the evidence rules out every viable branch without establishing a cause, set\nthe defect `inconclusive` with a precise account of what remains unknown.\n\n## Stop conditions\n\nStop this invocation when any condition holds:\n\n- the defect reached `root-caused`, `inconclusive`, `resolved`, or `wontfix`;\n- every unresolved branch waits on an open question or active research;\n- the round produced no new validated evidence and no justified child;\n- the same blocked state recurs without a new lead;\n- a required external capability remains unavailable.\n\nThere is no fixed depth, child-count, or time cap. The bound is progress.\n\n## Handoff and report\n\nWhen standalone, write one `handoffs` item with `flow: \"investigate\"`, links to\nthe defect, hypotheses, research, goal, and questions, and one of:\n\n- `drained`: cause confirmed or investigation conclusively exhausted;\n- `answers-required`: open requirements question;\n- `user-action-required`: specific unavailable external action;\n- `illness-detected`: actionable state remained but no legal progress occurred.\n\nSuppress this handoff when chained by another CQ command.\n\nReport the defect status, hypotheses created/adjudicated, validated evidence,\nprobe/research activity, the confirmed cause or remaining uncertainty, the\ndefect-seeded goal, and the exact next action.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n{{cq:fragment:ledger-response-contract}}\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"free-text empirical question or existing research id\"\noutputs:\n  - \"new/resumed research, inline research round, and one outer handoff\"\nioSchema:\n  - \"research lifecycle: open -> wip -> concluded|inconclusive; abandonment is user-initiated\"\n```\n\nUse research only for unknowns answerable by evidence or experiment. A\nrequirements, policy, scope, or preference choice belongs in a user question\ninstead.\n\nIf `$ARGUMENTS` names an existing research item, fetch it with full projection.\nReject missing or terminal (`concluded`/`abandoned`) items; resume `open`,\n`wip`, or `inconclusive`.\n\nFor free text:\n\n1. Recheck empirical-versus-user triage.\n2. Search active researches by key terms and resume a matching item instead of\n   duplicating it.\n3. Derive an optional bounded scope from the supplied context.\n4. Create a `Research: <short slug>` coordination milestone.\n5. Create an `open` research item with the complete question and optional\n   scope.\n\nRun `CQ::research/advance <researchId>` inline. It owns hypotheses, explorers,\nexperiments, evidence validation, adjudication, synthesis, and child logs.\nSuppress its handoff because this wrapper writes one using the research-advance\nmapping.\n\nReport whether the research was created or resumed, its milestone/scope, and\nthe complete round outcome. Resume later with research advance directly.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n{{cq:fragment:ledger-response-contract}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"research id ($ARGUMENTS first token)\"\n  - \"full research item, linked questions, and hypothesis tree\"\noutputs:\n  - \"hypothesis nodes and validated evidence\"\n  - \"research status and, when concluded, findings/conclusion/recommendation plus a cited synthesis log\"\n  - \"standalone handoff\"\nioSchema:\n  - \"one idempotent, resumable research round per invocation\"\n  - \"explorer result: {hypothesisId, evidence[], lean, notes?, probeRequest?}\"\n  - \"experimenter result: {hypothesisId, evidence[], lean, notes?}\"\n```\n\nYou orchestrate one research round for the research id in `$ARGUMENTS`. You own\nthe hypothesis tree, citation validation, adjudication, and ledger writes.\nChildren only gather evidence; they never adjudicate or mutate the ledger.\n\n{{cq:fragment:subagent-dispatch}}\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Invariants\n\n- Re-derive state from the ledger. Each round must dispatch a child or make a\n  state-changing write. Stop after two consecutive read-only passes.\n- Move `researches` from `open` to `wip` before doing research. Only `wip` may\n  transition to `concluded` or `inconclusive`. Never set `abandoned`.\n- Hypotheses use `open | uncertain | confirmed | wrong`,\n  `parentHypothesis` for ancestry, and `ledgerRefs:\n  [\"researches:<researchId>\"]`. Store only revalidated evidence, prefixed\n  `[correct]` or `[incorrect]`.\n- Dispatch disjoint root hypotheses in parallel. Drill a branch serially\n  because each child depends on validated parent evidence.\n- Resolve `tiers.frontier` once with\n  `ledger::get_config(\"tiers\")`. Pass its model token verbatim.\n  If unavailable, inherit the current model; never invent one.\n- Persist each child summary and available raw transcript through `cq log put`,\n  attach their logical paths in the same item update as the evidence, and never\n  expose capabilities or secrets. Before piping a transcript, require `test -s\n  <transcript>` so empty or whitespace-only captures are skipped rather than\n  written. Do not write research artifacts into the working tree.\n\n## Round\n\n### 1. Read and gate\n\nFetch the research with full projection. Find its hypothesis nodes and linked\nquestions by exact `ledgerRefs` membership. Reconstruct ancestry from\n`parentHypothesis`.\n\nIf a linked question remains `open`, stop: the round waits for the user. Fold\nanswers from `answered` questions into later framing. If a confirmed node\nalready answers the research but synthesis was interrupted, resume at\nConclusion.\n\nOtherwise set an `open` research to `wip` before continuing.\n\n### 2. Extend the tree\n\nCreate one root hypothesis for each distinct candidate answer not already\nrepresented. When an `uncertain` node needs decomposition, create narrower\nchildren. Prefer the most promising uncertain branch; seed several roots\ntogether only when they are independent. Use the research item's milestone.\n\n### 3. Gather evidence\n\nDispatch `research-explorer` for each frontier node with:\n\n```json\n{\n  \"researchId\": \"<RS id>\",\n  \"hypothesisId\": \"<id>\",\n  \"statement\": \"<verbatim hypothesis>\",\n  \"branchContext\": \"<research question, ancestry, validated sibling evidence, and adjudication target>\",\n  \"leads\": [\"<optional file, symbol, query, or URL>\"]\n}\n```\n\nExplorers read repository and external authoritative sources. They return\nevidence with citations and may request a probe when observation alone cannot\nsettle the hypothesis.\n\nFor a warranted `probeRequest`, dispatch `research-experimenter` in a\nthrowaway worktree with the request, hypothesis, branch context, and base\ncommit. Network access and worktree-local dependency installation are allowed.\nThe experimenter may execute probes but must not persist changes outside the\nworktree or request another probe. Harvest its evidence, then remove the\nworktree.\n\nTreat malformed child output as a contract breach. Do not accept partial data.\n\n### 4. Validate and adjudicate\n\nIndependently reopen every cited repository location, retrieve every cited\nexternal source, or rerun every cited command. Mark an item `[correct]` only\nwhen the source matches the excerpt, carries adequate authority, and bears on\nthe hypothesis; otherwise mark it `[incorrect]`.\n\nUpdate each hypothesis once with accumulated evidence, child log paths, and:\n\n- `confirmed` when correct evidence establishes it;\n- `wrong` when correct evidence rules it out;\n- `uncertain` when further decomposition can decide it;\n- `open` when no usable evidence returned.\n\nAdjudicate from `[correct]` evidence only. Then:\n\n- if confirmed nodes answer the research, conclude;\n- if no branch remains adjudicable, set the research `inconclusive` and ask\n  the user only when a genuine user-controlled input could unblock it;\n- otherwise leave the research `wip` for another round.\n\n### 5. Conclusion\n\nWhen the question has an evidence-supported answer, update the research to\n`concluded` with:\n\n- `findings`: the validated evidence narrative and citations;\n- `conclusion`: the direct answer;\n- `recommendation`: the resulting action, if any;\n- all round `sessionLogs` and available `rawLogs`.\n\nCompose the full cited synthesis—question, adjudicated tree, evidence, and\nexcerpts—and route it through `cq log put` to\n`logs/<timestamp>-research-<researchId>.md`. Record the returned logical path in\n`sessionLogs`. Never create this artifact in the repository.\n\n### 6. User input\n\nCreate an `open` question linked to the research only for:\n\n- a requirements or preference choice that changes the question's meaning;\n- unavailable data, hardware, credentials, or external access required for a\n  decisive probe.\n\nDo not ask whether research should continue, whether scope feels large, or\nwhether the user wants to abandon it. Narrow broad questions to an answerable\ncore. Leave the tree intact and stop after filing the question.\n\n## Report and handoff\n\nReport nodes created or adjudicated, experiments run, citation validation\ncounts, research status, conclusion and synthesis path, and any blocking\nquestion. Say another round is warranted when open or uncertain nodes remain.\n\nWhen invoked standalone, write exactly one append-only `handoffs` item:\n\n- `drained`: concluded or no branch remains;\n- `answers-required`: blocked by open questions;\n- `user-action-required`: a named item requires a specific external action\n  only the user can perform;\n- `mixed`: more than one of the above;\n- `illness-detected`: a protocol or invariant failure prevents progress.\n\nSet `flow: \"research\"`, relevant `ledgerRefs`, required\n`blockingQuestions`/`handoffReasons`, and this round's log paths. Do not write a\nhandoff for an ordinary context-window interruption; durable ledger state is\nthe resume point. Never use effort, elapsed time, or remaining work size as a\nstop condition.\n\nWhen invoked inline by another flow, suppress this handoff; the outermost\ncommand owns it.",
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
  "optional milestone ids; empty selects eligible finalized-manifest work"
],
    outputs: [
  "scope/ready-set report, inline implementation run, and one outer handoff"
],
    ioSchema: [
  "bootstrap only; implement advance owns execution and suppresses its nested handoff"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:inline-command-recursion}}\n\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"optional milestone ids; empty selects eligible finalized-manifest work\"\noutputs:\n  - \"scope/ready-set report, inline implementation run, and one outer handoff\"\nioSchema:\n  - \"bootstrap only; implement advance owns execution and suppresses its nested handoff\"\n```\n\nWith explicit ids, canonicalize and validate the complete batch before its\nfirst effect: every milestone must exist, remain active in the current workset\ngraph when roots are configured, and contribute only tasks from its exact\nfinalized manifest. Without ids, configured roots select only eligible\nfinalized-manifest work in the current graph; empty roots retain the historical\nunrestricted selection of all active milestones containing non-terminal tasks.\nDo not ask for scope, branch, or cadence confirmation; the current branch is\nthe integration target and the run continues until drained or genuinely\nblocked.\n\nRead tasks, task dependencies, milestone dependencies, and linked questions.\nReport target ids, task counts, and the initial ready set. A target with no\nready task may remain included while other targets progress.\n\nRun `CQ::implement/advance` inline for the resolved set. It owns worktrees,\ndispatch, review, correction, questions, verification, merge-back, logs, and\nthe final execution report. Suppress its handoff because this wrapper writes\none using the implement-advance mapping.\n\nAfter user answers unblock tasks, resume with implement advance directly; the\nbootstrap need not run again.",
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
  "optional milestone ids; empty resumes eligible finalized-manifest work",
  "full task state, dependencies, linked questions, worktrees, and reviewer configuration"
],
    outputs: [
  "task transitions, one terminal review per task, verified fast-forward merges, defect closure, and milestone archival",
  "standalone handoff"
],
    ioSchema: [
  "worker: {taskId,status,resultCommit,branch,actualWorktreePath,baseVerification,filesTouched,checkSummary,gateDurationMs?|supervisedGateEvidence?,summary,blockedReason?}",
  "reviewer: {taskId,verdict,criticism[],questions[],defects[],rationale,resultCommitEvidence,baseAncestry,summary?}",
  "resolver: {taskId,status,resultCommit?,summary,blockedReason?}"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:operational-tool-vocabulary}}\n\nEffect-boundary authority follows this shared contract:\n\n{{cq:fragment:workset-effect-discipline}}\n\n## Catalogue\n\n```yaml\ninputs:\n  - \"optional milestone ids; empty resumes eligible finalized-manifest work\"\n  - \"full task state, dependencies, linked questions, worktrees, and reviewer configuration\"\noutputs:\n  - \"task transitions, one terminal review per task, verified fast-forward merges, defect closure, and milestone archival\"\n  - \"standalone handoff\"\nioSchema:\n  - \"worker: {taskId,status,resultCommit,branch,actualWorktreePath,baseVerification,filesTouched,checkSummary,gateDurationMs?|supervisedGateEvidence?,summary,blockedReason?}\"\n  - \"reviewer: {taskId,verdict,criticism[],questions[],defects[],rationale,resultCommitEvidence,baseAncestry,summary?}\"\n  - \"resolver: {taskId,status,resultCommit?,summary,blockedReason?}\"\n```\n\nYou orchestrate implementation. Children never mutate the ledger or merge.\nRe-derive state on every invocation. A pass must dispatch a child, mutate the\nledger, or merge; stop after two consecutive read-only passes.\n\nCanonicalize and validate an explicit milestone batch before its first effect.\nWith configured roots, select only active graph members belonging to each\nmilestone's exact finalized manifest; without explicit ids, resume only\neligible finalized-manifest work. Empty roots retain unrestricted historical\nselection. Preserve the selected finalized manifest exactly through dispatch,\nreview, correction, rebase, merge, and terminal writes; re-read the workset at\nthe effect boundaries required by the shared contract.\n\n{{cq:fragment:subagent-dispatch}}\n{{cq:fragment:implement-dispatch-workflow}}\n\n## Shared rules\n\n- Resolve `tiers` and `reviewers` once per pass with\n  `ledger::get_config(\"tiers\")` and `ledger::get_config(\"reviewers\")`.\n  Workers use their task's `suggestedModel`; reviewers and conflict resolvers\n  use `tiers.frontier`. Pass configured model aliases verbatim. If a tier is\n  absent, inherit the current model and report the missing configuration.\n- Run at most eight workers concurrently. Each task uses an isolated worktree\n  and branch `implement/<taskId>`.\n- **Managed worktrees.** ALL worktree lifecycle goes through\n  `ledger::worktree_manage` — never raw git worktree lifecycle commands\n  (add/remove/prune) on any active implement/advance surface. Before changing a\n  task to `wip` or launching a worker, call\n  `worktree_manage({ operation: \"prepare\", taskId, baseCommit: <full main tip> })`\n  (or resume-by-handle with the retained opaque handle). Accept only a prepare\n  result whose dependency-base evidence is verified. Pass the returned absolute\n  path as advisory `worktreePath` on the child input. Retain the opaque handle\n  across criticism rounds; on orchestrator restart, recover via prepare's\n  resume-required response for that taskId and resume the same tree. Never\n  discard worker partial/WIP state. Consume the worker's required\n  `actualWorktreePath` on output as the authoritative location; merge by\n  `resultCommit` SHA.\n- **Parent-lost dispatch recovery.** After a manager-bound implement-worker is\n  terminally aborted `parent-lost`, retain its exact worktree handle and call\n  `worktree_manage({ operation: \"resolve-dispatch-recovery\", handle })`. Accept\n  only the server-returned opaque `recoveryReference`; persist that literal\n  reference with the task's recovery metadata and `cq log put` record. Re-read\n  the worktree `HEAD` and require it to equal the returned live tip, then call\n  `prepare_dispatch` with `recovery: <recoveryReference>` and without\n  `reprepareOf`. The server resolves the exact terminal generation and injects\n  only its verified durable Git receipt lineage. Never retry an advanced tip as\n  a fresh lineage-free dispatch, never reconstruct a prior dispatch handle or\n  recovery association from registry files, and never substitute raw\n  attestation, repository, worktree, branch, base, tip, terminal, or receipt\n  coordinates for the opaque reference.\n- **Consumed-worker continuation.** A consumed manager-bound implement-worker\n  whose worktree remains live is continued only through its single-use opaque\n  association. Before an ordinary criticism redispatch, or before parking a\n  consumed worker for later resumption, call\n  `worktree_manage({ operation: \"resolve-dispatch-continuation\", handle })` and\n  accept exactly one server-returned `continuationReference`. Persist that\n  literal reference with the task metadata and `cq log put` record. Re-read\n  `HEAD`, require it to equal the returned live tip, then call\n  `prepare_dispatch` with `continuation: <continuationReference>` and without\n  `reprepareOf`, `recovery`, or `guardedRebase`. The server resolves the consumed\n  generation, complete receipt closure, manager identity, repository binding,\n  and authorized caller lineage, and atomically claims the association while\n  allocating its successor. A missing, ambiguous, expired, stale, foreign, or\n  already-claimed reference blocks redispatch; never reconstruct terminal\n  handles, receipts, or capabilities. Guarded-rebase redispatch remains the\n  explicit `reprepareOf` + `guardedRebase` exception described below.\n- **Exact pre-registry adoption.** When, and only when, a task already has a\n  pre-registry tree at the canonical\n  `<repositoryRoot>/.claude/worktrees/implement-<taskId>` path on branch\n  `implement/<taskId>`, observe its full `HEAD` and use handle-free prepare:\n  `worktree_manage({ operation: \"prepare\", taskId, baseCommit, adoptWorktreePath: <exact canonical path>, expectedHead: <observed full HEAD> })`.\n  Supply `adoptWorktreePath` and `expectedHead` only as a pair and never with\n  a handle. Supply no activity fence, registry, reconciliation, Git, or install\n  authority; the production server constructs those internally. A mismatch or\n  refusal blocks the `wip` transition and launch. Retain the returned opaque\n  handle for all later resume, criticism, conflict, and release operations.\n- Persist every child summary and available raw transcript with `cq log put`,\n  attach their logical paths to the affected ledger item, and never expose\n  capabilities or secrets. Before piping a transcript, require `test -s\n  <transcript>` so empty or whitespace-only captures are skipped rather than\n  written.\n- The surface-specific fragment defines dispatch input delivery and result\n  materialization. Retain the parent-prepared handle. Interpret a native\n  result only after the exact retained handle yields `state: \"consumed\"`.\n  Never inspect a body-returning completion or trust a child-reported handle.\n- A missing or non-consumed native result is a LOST REPORT. Log it. For a\n  manager-bound implement-worker, use the parent-lost recovery procedure above;\n  other roles retry the same role once with a fresh prepared dispatch. A second\n  loss fails that task path closed, leaves the task non-terminal and its worktree\n  intact, and cannot become a worker failure, reviewer abstention, or resolver\n  verdict.\n\n## 0. Activate protected historical implementation evidence\n\nBefore the ordinary activation probe, resolve the selected goal's exact current\nfinalized-manifest mappings for `t-evidence`, `t-historical-evidence`, and\n`t-activate-evidence` and read those three tasks. When replacement evidence is\nnot active, use this **manifest-derived bootstrap mode** and no other readiness\npath:\n\n- while the exact mapped `t-evidence` task is `planned`, derive the ready set\n  through the ordinary §1 rules, require that task to be ready, and process only\n  the exact mapped `t-evidence` task through §§3–7. No other task may prepare,\n  dispatch, review, or merge in that pass. Stop `user-action-required` after\n  recording its terminal completion so the user can deploy/restart its exact\n  result before the next bootstrap step;\n- after `t-evidence` is `done` and `t-historical-evidence` is `planned`, call\n  `get_implementation_evidence_service_status` through the deployed evidence\n  task's authenticated management service with no caller-supplied goal,\n  manifest, mapping, commit, or action identity. Require protocol version 2;\n  exact operation inventory; `startupBuildCommit` equal to the evidence task's\n  result commit; the observed live repository head; exact frozen digest and\n  mappings; a recognized bootstrap phase; and the exact\n  `finalizedReviewOutcomeContract`. Then call\n  `advance_implementation_evidence_bootstrap` with that returned identity and\n  `expected_phase: \"historical-dispatch\"`. Accept only `admitted|existing`, one\n  opaque `<bootstrapRef>`, and only the exact historical task. Prepare only that\n  task and pass\n  `implementationEvidenceBootstrap: <bootstrapRef>` to `prepare_dispatch`;\n  missing, stale, local-only, predecessor, replayed, or mismatched authority\n  stops before worktree preparation. After recording its terminal completion,\n  stop `user-action-required` for deployment/restart at that exact result;\n- after both Git tasks are `done`, while the unchanged evidence-task service is\n  still deployed, call `get_implementation_evidence_service_status` again and\n  require the same startup build and frozen identity. Call\n  `advance_implementation_evidence_bootstrap` with the returned identity and\n  `expected_phase: \"activation-handoff\"`, including when the v2 packaged\n  registry is unavailable. Accept only `operator-action-required|existing`,\n  the exact activation task, canonical action key\n  `activate-implementation-evidence`, expected historical-service commit, and\n  opaque action and handoff references. Materialize no worktree and dispatch no\n  third Git task. Stop `user-action-required` so the user can deploy/restart the\n  historical task's exact result.\n\nThis bootstrap mode never treats task prose, a local checkout, a generic write,\nor patch/tree equivalence as authority. A missing or ambiguous mapping, a\nnon-strict activation envelope, a surplus selected task, or any task-state\ncombination outside the three cases above stops closed. Once the exact\nactivation action is verified and complete, leave bootstrap mode and require\nthe ordinary active probe below.\n\nAfter the user deploys/restarts the historical task result, call\n`get_implementation_evidence_service_status` and require\n`startupBuildCommit` to equal that exact result. Complete, in order, **arm,\naudit, apply, active proof, operator evidence, and typed completion**. Probe the\nexact implementation-evidence activation manifest selected by the current\nfinalized mapping with the current goal reference, manifest id, and expected\nrepository head, binding the full observed integration HEAD. Never fall back\nto an older packaged manifest. Reject every noncanonical action key and require\nthe `activate-implementation-evidence` envelope. Continue to ordinary\nreconciliation only from `active`.\n\nFor `absent`, call `arm_implementation_evidence_activation` with the same goal,\nmanifest, head, one stable operation id, author, and session. Accept only the\nexact finalized-manifest mappings returned for `t-evidence`,\n`t-historical-evidence`, and `t-activate-evidence`; never substitute predecessor\ntask literals. Retain the returned packaged manifest digest and complete ordered\n`recordKey`/`taskRef` coordinates as the sole inputs to audit-panel preparation\nand final application; never derive either from caller-side storage or naming\nconventions. The first two tasks must already be done, the activation task must\ncarry the strict `CQ-OPERATOR-ACTION v1\nactivate-implementation-evidence.` envelope, and the frozen boundary must\nequal the observed head.\n\nFor every returned packaged record not already backed by a mechanically sufficient\nauthenticated implementation review, call\n`prepare_implementation_audit_panel`, then prepare each ordered opaque attempt.\nNative attempts dispatch only the returned `implementation-auditor` payload;\nadapter attempts run only through\n`execute_external_implementation_audit_attempt`. Finalize every attempt through\n`finalize_implementation_audit_attempt`. If and only if the entire configured\nroster terminally abstains, use `prepare_implementation_audit_fallback` once\nand finalize that authenticated native attempt. Never manufacture a verdict or\nsend the ordinary implement-reviewer worktree contract.\n\nCall `apply_implementation_audit_manifest` with the exact manifest id/digest,\nhead, and complete ordered attempt-ref set. Missing, surplus, reordered,\nforeign, or nonterminal refs block the whole application. Re-probe status and\nrequire `active` before deriving ready work. `pending`, `stale`, incomplete, or\nany preparation/application refusal stops this pass closed; do not dispatch\nreconciliation, use generic writes, or infer activation from task prose,\nreviews, logs, tags, or resultCommit text.\n\nThe canonical activation manifest is\n`d347-implementation-evidence-activation-v2`. `active` is the only state that\nadmits ordinary work. A `stale` probe with a null activation ref may re-arm only\nafter a retained descendant-head parent correction and only through\n`arm_implementation_evidence_activation`. Accept that recovery only when the\nresponse names the exact stale requirement as `supersededRequirementRef`,\nreturns the unchanged semantic manifest/mappings/cohort at the new head, and\nthe server proves the stale requirement had no prepared panel, audit, or\napplication. Continue with only the replacement arm's returned digest and\nrecord coordinates.\n\nA `stale` probe with a non-null activation ref may recover only one already-recorded,\none-step protected transition: identify the unique finalized-manifest Git task\nwhose terminal go-ahead review names one recorded completion from the stale\nrequirement's exact boundary to the current head, then replay one stable\n`continue_implementation_evidence_activation({ goal_ref, manifest_id,\nprior_requirement_ref, completed_task_ref, completion_ref,\nexpected_from_head, expected_repository_head, operation_id, author, session })`\nrequest. Accept only `continued|existing` with every returned ref, task, head,\nand completion equal to that request, then re-probe and require `active`.\nAbsent, pending, multi-step, surplus, rewritten, ambiguous, unaudited, or\nchanged-input recovery stops closed and dispatches nothing. Never arm, audit,\nor apply again to repair a stale fulfilled head, and never read protected storage,\ndiagnostics, summaries, or logs to reconstruct continuation authority.\n\n## 1. Derive the ready set\n\nBefore selecting or dispatching work, recover every active implementation\ncompletion journal by calling `record_implementation_completion` for its task\nwith the exact observed integration head and a stable recovery operation id.\n`merge-required` resumes only the journal-bound merge below;\n`reprepare-required` closes no authority and requires rebase plus a fresh\nauthenticated panel before a new prepare naming `supersedes_completion_ref`;\n`recorded|existing` resumes defect reconciliation and release. A\n`merge-started` or merged-but-unrecorded journal blocks every other repository\nmerge until this recovery records it. Never fall back to generic task/review\nwrites or an unjournaled merge.\n\nRead each target milestone and its full task items, linked questions, milestone\ndependencies, and referenced dependency items.\n\nBefore dispatch, prune stale worktree metadata and inspect all implementation\nand runtime-created worktrees via prepare/resume semantics. Never touch the\nmain checkout, the ledger backup branch, a worktree for a `wip`/`blocked` task,\nor an unmerged worktree without a terminal task association. Release a worktree\nonly through guarded\n`worktree_manage({ operation: \"release\", handle, terminalDisposition, … })`\nwhen the associated task is terminal (`done`/`abandoned`) and release guards\npass. Never infer safety from a branch name alone. Never raw-remove or prune.\n\nChange a `blocked` task back to `planned` after all linked questions become\n`answered`; include the answers in its next dispatch.\n\nA task is ready when:\n\n- its status is `planned`;\n- it has no open linked question;\n- every resolvable `dependsOn` item has a satisfying status declared by its\n  ledger (`tasks:done`, `defects:resolved`, `questions:answered`, and analogous\n  configured sets);\n- every prerequisite milestone has all tasks terminal.\n\nA description beginning exactly\n`CQ-OPERATOR-ACTION v1 <action-key>.` selects the closed operator-action\narm below. The key contains ASCII alphanumeric segments separated by single\nhyphens, for example `deployed-recovery`. The store rejects a misplaced,\nmalformed, or duplicate envelope.\nSuch tasks appear only in `pOperatorAction`, never `pImplement`, and MUST NOT\nenter worktree preparation, `wip`, worker dispatch, review, rebase, merge, or\nrelease logic.\n\nTerminal-but-unsatisfying statuses such as `abandoned` and `wontfix` do not\nsatisfy dependencies. Advisory or unresolvable free-text references do.\n\nIf no task is ready and no task awaits review or merge, report and stop.\n\n## 2. Operator-action tasks (parent only)\n\nFor each DAG-ready strict-envelope task, keep the actor split explicit:\nthe user performs deployment and acknowledges its observed identity; this\nparent runs bounded shell probes after acknowledgement. A child, worktree,\nmerge, push, deploy, switch, or implicit acknowledgement is forbidden.\n\n1. Resolve one exact expected output identity and a non-empty, closed list of\n   exact probe commands from the task description and acceptance. Build/package\n   output observation may establish the identity; do not deploy it. If the task\n   does not specify enough information to make either exact, stop\n   `illness-detected` rather than inventing acceptance.\n2. Call\n   `ledger::materialize_operator_action({ task_id, expected_output_identity,\n   expected_evidence, author, session })` before any ordinary readiness action.\n   Accept only `created` or exact `existing`. This deterministically creates or\n   restart-reuses one pending revision-1 action and one `user-action-required`\n   handoff; conflicting identity/evidence fails closed.\n3. While pending, park without changing the task to `wip`. Report the action id,\n   current revision, exact identity, handoff id, and the user instruction to\n   deploy then call `ledger::acknowledge_operator_action` with that\n   `expected_revision`. A mismatching acknowledgement leaves the action pending\n   and authorizes no probe. A replay against an already `verified` action returns\n   `verified`; skip directly to typed completion.\n   If the persisted identity or evidence contract proves incorrect before any\n   evidence exists, or a pending action's current acknowledgement epoch ended\n   in recorded failure, this parent may call\n   `ledger::revise_operator_action({ action_id, expected_revision,\n   expected_output_identity, expected_evidence, revised_at, author, session })`\n   with the exact current revision and complete replacement contract. For the\n   evidence-bearing exception, require the terminal evidence entry and\n   `lastFailure` to identify the same failed probe in the current revision and\n   acknowledgement epoch; fail closed on malformed, stale, or inconsistent audit\n   state. The revision CAS preserves the exact prior action/task/handoff snapshot,\n   advances to the next revision, clears acknowledgement and evidence state,\n   refreshes the handoff, and returns an abandoned linked strict task to\n   `planned`. Reject successful partial evidence, acknowledged evidence without a\n   terminal failure, verified or completed actions, stale revisions, and unsafe\n   task/handoff states. Never use generic reopening as a substitute.\n4. After the exact user acknowledgement returns `acknowledged`, run only the\n   persisted commands, sequentially and with bounded stdout/stderr capture.\n   After each command call `ledger::record_operator_action_evidence` with the\n   current `expected_revision`, literal command, stdout, stderr, exit code,\n   observed output identity, and timestamp. Evidence is append-only and bound\n   to that revision. A nonzero exit or identity mismatch returns the action to\n   pending; do not erase earlier observations or finish the task. After the next\n   exact acknowledgement, rerun every persisted probe; successes from an earlier\n   acknowledgement/failure epoch do not count toward verification.\n5. Only a `verified` action authorizes\n   `ledger::complete_operator_action({ action_id, expected_revision, completion,\n   author, session })`. Re-read the action and pass its current revision before\n   every acknowledgement, evidence, revision, or completion call. This typed\n   transition marks the linked task `done`. Re-derive predicates; never use\n   generic `update_item` or another resurrection operation to bypass verification.\n\n## 3. Dispatch workers\n\n**Prepare BEFORE wip and BEFORE launch.** For each selected task:\n\n1. Resolve the intended base as the current full main tip with\n   `git rev-parse --verify` and require `git cat-file -t` to return `commit`.\n2. Call `worktree_manage({ operation: \"prepare\", taskId, baseCommit })` (or\n   the exact pre-registry handle-free prepare above, or resume-by-handle with\n   the retained handle / allowResumeRequired recovery). On adoption or\n   resume-required, retain the returned handle and path and continue on that\n   tree — do not mint a second tree for the same task. Never use adoption for\n   any non-canonical path, branch, task identity, or changed `HEAD`.\n3. Accept only verified dependency-base evidence from prepare. Missing or\n   unresolvable dependency `resultCommit` evidence blocks dispatch without a\n   `wip` write; it becomes actionable after the ledger object is corrected.\n4. Resolve the authoritative tip with\n   `git -C <worktree> rev-parse --verify HEAD`, retain it as `startingCommit`,\n   and require `git -C <worktree> cat-file -t <startingCommit>` to return\n   `commit` plus\n   `git merge-base --is-ancestor <verifiedBaseCommit> <startingCommit>` to exit\n   zero. Immediately before launch, require the current worktree `HEAD` to equal\n   that retained `startingCommit`. Retain the exact `baseCommit`, `round`,\n   `startingCommit`, and opaque worktree handle; never reconstruct them from a\n   child report.\n5. Only after prepare succeeds: if the linked owning goal is `planned`, move it\n   once to `building` (never terminal). Set the task `wip`.\n6. Dispatch `implement-worker` with the exact task specification, advisory\n   `worktreePath` from prepare, branch, verified full-SHA base, required\n   `round` (0 on first dispatch; increment on each criticism re-dispatch),\n   authoritative `startingCommit`, optional `priorResultCommit` on round>0, and\n   any prior criticism.\n7. Materialize only a consumed, schema-valid result through the dispatch\n   protocol. Before accepting a passing result, require its `resultCommit` to be\n   a commit, the worker branch tip to equal it,\n   `actualWorktreePath` to be a non-empty absolute path,\n   `baseVerification.status === \"verified\"` with full SHAs, and\n   `git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.\n   When the dispatch carried `gitChangeCapability`, also require a non-empty\n   `gitReceipts` chain: every receipt old/new edge and tree must match Git, the\n   chain head must equal `resultCommit`, and its path union must equal\n   `filesTouched`. The trusted server validates the same invariants before\n   storing a broker-capable passing result.\n\n**Harvest then prefer RESUME.** Before every (re)dispatch, inspect the task\nworktree for a partial artifact — a `WIP-<taskId>.md` (or equivalent\ndeliverable) in the existing WIP partial format with open checkpoints, plus any\nuncommitted or committed-but-incomplete work. When a self-describing partial\nexists, RESUME the same worker in the same managed worktree (same handle) onto\nthat partial rather than preparing a fresh empty tree. Re-running an expensive\nprobe to recover work already done is the expensive failure mode; resumption is\npreferred when there is durable state to resume onto. When the prior return is a\nLOST REPORT or an incomplete turn, harvest first, then resume.\n\nA base-only repair / reprepare / rebase maintenance round does **not** count as\ncriticism, no-files output, or an ill-loop counter increment.\n\n## 4. Review\n\nBefore any review dispatch, require\n`git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.\nReview each passing worker result against the actual `baseCommit..resultCommit`\ndiff, acceptance criteria, and gate evidence. A worker failure enters the\ncriticism loop using `blockedReason`.\n\nFor a brokered Codex worker, accept only runner-owned\n`supervisedGateEvidence` attached by the trusted result-storage boundary.\nRequire exact task/result commit/branch/worktree bindings, canonical command,\nclean tree, `gateExitCode === 0`, `failCount === 0`, and `passCount > 0` before\nreview dispatch. Never accept caller-minted evidence or a passing result that\nstill contains caller-supplied `gateDurationMs`.\n\nBefore launching any reviewer, call\n`prepare_implementation_review_panel({ task_ref, result_commit,\nworker_dispatch, operation_id, author, session })`. Retain its exact\n`panelRef`, `rosterDigest`, and ordered opaque `attemptRefs`; never derive,\nreorder, omit, duplicate, or append a ref. The server snapshots the configured\nroster and binds every attempt to the task, result commit, configured position,\nidentity, and consumed worker dispatch.\n\nFor every returned ref in order call\n`prepare_implementation_review_attempt({ panel_ref, attempt_ref, operation_id,\nauthor, session })`. A `launch: native` response carries the only\n`DispatchPrepared` that may launch that reviewer; consume it through the native\ndispatch protocol. A `launch: adapter` response authorizes no caller shellout:\ncall `execute_external_implementation_review_attempt({ attempt_ref,\noperation_id, author, session })`, which resolves and executes the configured\nadapter and prepare-bound input inside the trusted parent. Call\n`finalize_implementation_review_attempt({ attempt_ref, operation_id, author,\nsession })` for every attempt. The finalizer derives its receipt only from the\nbound consumed native dispatch or trusted adapter execution. Callers never\nsubmit a verdict, abstention, stdout, stderr, exit code, or adapter identity to\nan evidence operation. Require every finalizer response to carry exactly one\nbounded `outcome`: either `{ kind: \"verdict\", verdict }` or\n`{ kind: \"operational-abstention\" }`. Use the returned validated\n`outcome.verdict` as the sole source of the attempt's exact criticism,\nquestions, and defects for reconciliation and correction redispatch. Never\ninfer those fields from `terminalState`, raw process output, task prose, logs,\nor protected store state.\n\n**Sandboxed reviewer gate evidence.** Pass a consumed worker's verified\n`supervisedGateEvidence` through to a sandboxed `implement-reviewer` and require\nthe reviewer to validate its exact bindings and green counts without rerunning\nthe gate. For a legacy result without this evidence, when a surface's dispatch\nworkflow requires parent-attested gate evidence (gate primitives denied), the\nparent MUST attach `parentGateAttestation` built from a just-run or freshly run\nfull gate on the worker tip:\n`{ resultCommit, gateExitCode, passCount, failCount, gateDurationMs?, command,\ncapturedAt }` with exact tip match, `gateExitCode === 0`, `failCount === 0`, and\n`passCount > 0`. Do not escalate the child sandbox to gain gate primitives.\nNon-sandboxed reviewers omit the attestation and still re-run the gate\nthemselves; their approve path still requires child `gateReRan=true`.\n\n**External reviewer usable-verdict rule.** Fence-strip and validate stdout first.\nA complete, parseable verdict counts as a vote despite a non-zero shell exit;\nlog that exit anomaly. Require full-object validation before accepting the\nverdict. Only empty, malformed, failed, unavailable, or off-contract execution\nbecomes an authenticated `operational-abstention`, never caller-authored JSON.\n\n**External reviewer no-timeout rule.** No wall-clock timeout is imposed.\nFence-strip and validate stdout first. A complete, parseable verdict counts as\na vote despite a non-zero shell exit; log that exit anomaly. A non-zero exit\ncauses abstention only when no complete, parseable, fully validated verdict\nexists; a stalled adapter remains an operational failure rather than a silent\nabstention.\n\nIf and only if every configured attempt has finalized as\n`operational-abstention`, call\n`prepare_implementation_review_fallback({ panel_ref, operation_id, author,\nsession })` once and run/finalize its returned native attempt. The fallback\nreceipt binds the trigger and exact excluded adapter identities. Zero approved\nattempts can never approve a task.\n\nReconcile the complete finalized receipt set in configured order:\n\n- any `disapprove` wins; all must approve and the gate must be green for\n  `approve`;\n- union and source-tag `criticism`, `questions`, and `defects`, deduplicating\n  equivalent entries;\n- `approve` requires empty criticism/questions and verified\n  `resultCommitEvidence` + `baseAncestry` on every surviving native reviewer;\n- `disapprove` requires at least one criticism or question.\n\nFile each out-of-scope or pre-existing `defects[]` entry once as an open defect\nlinked to the task and owning goal. Under restrictive roots, create it through\nthe task owner using `owner_ref: \"tasks:<T>\"` and\n`creation_kind: \"implementation-defect\"`. Such defects do not block the\ncurrent task and never become user disposition questions.\n\n## 5. Correct or park\n\nWhen the reconciled verdict disapproves with criticism and no questions,\nredispatch the same worker in the **same managed worktree** (retained handle;\n`round` incremented; `priorResultCommit` = prior pass tip when present), then\nreview again. Resolve and claim the consumed-worker continuation authority above\nfor this ordinary redispatch; never pass the consumed attestation handle as\n`reprepareOf`. Round N+1 must retain round N commits. There is no fixed round cap\nwhile evidence shows convergence.\n\nPark the task when:\n\n- the review asks a genuine user-only requirements question;\n- a correction round makes no file change;\n- the same criticism repeats without shrinking across consecutive rounds;\n- the same gate failure signature repeats.\n\nCreate linked open questions with the round history. Under restrictive roots,\ncreate each through `owner_ref: \"tasks:<T>\"` and\n`creation_kind: \"exact-gate-question\"`. Then set the task `blocked` and\npreserve its worktree + handle. Do not ask the user to decide whether a\nconfirmed fault deserves a fix. When a consumed worker is the parked tip,\nresolve and persist its continuation reference before ending the pass.\n\n## 6. Success authority\n\nA task may merge only when all of these hold:\n\n- its latest worker and required native-reviewer results were consumed through\n  parent-retained handles;\n- the worker carries either trusted green `supervisedGateEvidence` or a\n  legacy in-child `REAL_CHECK_EXIT=0` gate result;\n- all surviving reviewers approved with empty criticism/questions and verified\n  commit/ancestry evidence;\n- the orchestrator independently verified the exact commit and ancestry.\n\nTreat `gateDurationMs` below `50`, absent/zero, or below one quarter of the\nmedian for earlier rounds of this same task as implausible. Apply this check\nonly to the legacy in-child arm. Re-run `bun run check` in the foreground and\nuse its real exit status. If that cannot be done, fail closed. Runner-owned\n`supervisedGateEvidence` carries its measured duration and does not use this\ncaller-plausibility heuristic.\n\nBefore rebase and immediately before merge, the orchestrator independently:\n\n1. require `git cat-file -t <resultCommit>` to return `commit` (full SHA);\n2. require the worker branch tip to equal `resultCommit`;\n3. require a clean claimed file set vs `filesTouched` / the actual diff;\n4. for a broker-capable result, revalidate the receipt chain heads, trees, and\n   path union against `resultCommit` and `filesTouched`;\n5. require `git merge-base --is-ancestor <verifiedBaseCommit> <resultCommit>`\n   to exit zero;\n6. require `git merge-base --is-ancestor <startingCommit> <resultCommit>` to\n   exit zero;\n7. require every dependency task `resultCommit` to be an ancestor of the tip\n   (or equal) when resolvable — missing/unresolvable dependency evidence forbids\n   merge.\n\nFabricated, missing, non-tip, stale-base, or non-ancestor result commits never\nmerge. Any failure is a contract breach and forbids merge-back.\n\n## 6a. Expected-failure tasks\n\n§6a governs only a task that declares an expected failure.\n\nForm (a), inversion marker: use the runner's test.failing or it.failing for an in-suite assertion.\n\nForm (b), subprocess exit-code assertion: spawn the failing tool as a child and assert its non-zero exit code and output.\n\nForm (c), green-on-arrival discriminating control: exercise the same detector with paired inputs or a pure mutation while the task's gate stays green.\n\nForms (a) and (b) express the expected failure inside a green full gate. Form\n(c) carries no marker. A red full gate remains unmergeable. Capturing failure\nagainst a parent commit may supplement, but never replace, these controls.\n\n## 7. Merge in DAG order\n\nProcess successful tasks sequentially after their dependencies have landed.\nIf main has advanced past the dispatch base, rebase onto current main and rerun\ngates + review before ff-only merge; that ancestry-only maintenance does not\nincrement criticism/no-files counters. If the tip changes under rebase, the old\nworker result loses authority: redispatch the worker on the rebased tree (same\nhandle), rerun its gate and review, and repeat the success checks.\n\n**Guarded rebase authority.** Run the rebase only through the task-bound\nbroker under one stable operation id, using the exact current main commit\nalready verified above:\n\n```sh\ncq gate git-effect --operation rebase --cwd <repositoryRoot> --task-id <taskId> --commit <currentMainCommit> --operation-id <stableRebaseOperationId>\n```\n\nChoose `<stableRebaseOperationId>` once per rebase maintenance round — for\nexample `implement-<taskId>-rebase-r<round>` — and reuse it verbatim when a\nresponse is lost or ambiguous: an exact replay returns the same authority\nwithout re-running the effect. A changed payload under a reused id is\nrejected; when main advances again, select a fresh operation id. Never run a\nrebase maintenance round without an operation id.\n\nA finalized guarded rebase prints exactly one machine-readable stdout line\n`CQ_GUARDED_REBASE_REFERENCE=cq-guarded-rebase:v1:<64 lowercase hex>`.\nCapture that exact reference and retain it as the sole rebase authority.\nMissing, malformed, duplicated, or mismatched handoff output stops the flow\nclosed: never fall back to raw Git, never read or reconstruct the rebase\njournal, and never mint coordinates or lineage yourself.\n\nRedispatch the worker on the rebased managed tree (same retained handle)\nsupplying only that parent-only reference with the exact terminal prior worker\ngeneration: the prepare carries `reprepareOf` naming the consumed pre-rebase\nworker handle and `guardedRebase` carrying the exact retained reference —\nnothing else from the rebase. The server, never the flow or the child,\nresolves the reference against its terminal durable journal and materializes\n`guardedRebaseLineage` into the worker input; a caller-supplied\n`guardedRebaseLineage` is always rejected. On this initial bridge round set\n`baseCommit` to the verified onto commit, `startingCommit` to the observed\nrebased worktree tip, and `priorResultCommit` to the exact pre-rebase worker\n`resultCommit`; the server verifies every coordinate against the journal and\nrejects any substitution. Never claim the rewritten pre-rebase commit is an\nancestor of the rebased tip — the exact-equality binding is the only ancestry\nexemption. The server-resolved lineage selects the mode: under `exactTip` the\nworker reports the exact rebased tip with an empty fresh receipt suffix and no\nearly WIP commit; any guarded correction that advances the tip keeps early\npersistence and a non-empty contiguous suffix beginning at the rebased head,\nand any later criticism round follows the ordinary persistence procedure.\n\nConsume the redispatched result only through the retained handle after the\nparent-owned gate attaches fresh green evidence bound to the exact rebased\ntip, then rerun every required reviewer against the rebased result and repeat\nthe success checks: pre-rebase worker, reviewer, and gate authority never\nauthorizes the rebased result. A prepare rejection, an unresolvable or stale\nreference, or a lineage mismatch stops the flow closed rather than falling\nback to raw Git, broadening the worker sandbox, or accepting caller-minted\nlineage or gate evidence. Only after the fresh gate and reviews pass does the\nexisting ff-only guarded merge below run.\n\nOn conflict, call `worktree_manage` with `operation: \"observe-conflict\"` and the\nmanager handle. Supply its exact `conflictState` (original tip, onto, dispatch\nbase, current HEAD and ancestry, sequencer identity/todo/current command, and\nevery unmerged stage OID/mode) to `implement-conflict-resolver`. Continue only\nfrom a consumed `pass` result whose\ndurable continuation receipts form one chain ending at its terminal\n`resultCommit`; then replay the identical guarded rebase command — same\noperation id, same commit — to reconcile the journal to its verified terminal\ntip and mint the reference before the redispatch above (a conflicted journal\nnever selects the exact-tip mode). A consumed `fail` must still carry the bound\nbranch, absolute\nworktree path, and the complete durable receipt chain; after any continuation\nits last receipt must end at the exact live nonterminal conflict state. Then\ncreate a linked question, set the task `blocked`, keep the worktree/handle, and\nskip its dependants.\n\nAfter the final checks and fresh approved panel, call\n`prepare_implementation_completion({ task_ref, expected_repository_head,\nresult_commit, worker_dispatch, review_attempt_refs, completion, log_paths,\nmerge_operation_id, supersedes_completion_ref?, operation_id, author, session })`.\nRetain its exact `{ completionRef, taskRef, resultCommit, repositoryHead,\nevidenceFingerprint }`. This prepare must precede the merge and must bind the\nexact finalized manifest, owner goal, worker result and receipt chain, gate and\nacceptance observations, clean diff, ancestry, immutable roster, complete\nordered finalized attempts, and intended ff-only merge. Any evidence mismatch\nfails closed without partial mutation.\n\nMerge the exact object only through the prepared journal, using the same stable\n`merge_operation_id` supplied to prepare:\n\n```sh\ncq gate git-effect --operation merge --cwd <repositoryRoot> --task-id <taskId> --commit <resultCommit> --completion-ref <completionRef> --operation-id <merge_operation_id>\n```\n\nCapture stdout and require exactly one\n`CQ_IMPLEMENTATION_COMPLETION_MERGE=<canonical JSON>` line. Parse and validate\nthat its status is `merged|existing` and that `completionRef`, `taskRef`,\n`resultCommit`, `repositoryHead`, `mergeOperationId`, and\n`evidenceFingerprint` exactly equal the retained prepare. Missing, malformed,\nduplicate, mismatched, or lost acknowledgement enters journal recovery; never\nretry with raw Git or the legacy commit-only command.\n\nImmediately call\n`record_implementation_completion({ task_ref, expected_repository_head,\noperation_id, author, session })`. Accept only `recorded|existing` with the\nsame completion/task/result/head/fingerprint. This protected transaction, not\n`update_item` or `create_item`, marks the task done with its result, completion,\nand log paths and creates exactly one terminal go-ahead review carrying strict\nversioned `implementationEvidence`. `merge-required` or `reprepare-required`\nreturns to recovery and forbids release or defect reconciliation.\n\nBefore release, defect reconciliation, or readiness rederivation, continue the\nactive v2 evidence requirement across this exact recorded merge. Call\n`continue_implementation_evidence_activation` with the previously active\n`requirementRef`, this task and the returned `completionRef`, the completion's\nprepared repository head as `expected_from_head`, the recorded merged head as\n`expected_repository_head`, and one stable operation id. Accept only\n`continued|existing` whose continuation, previous/new requirement, activation,\ntask, completion, and head bindings match exactly. Re-probe and require\n`active` at the merged head. Any absent/pending/stale prior activation,\nnonterminal or ambiguous completion, missing runner-owned green gate,\ndisapproved terminal review, foreign/surplus task, non-fast-forward ancestry,\nintervening unreceipted commit, semantic manifest drift, completion reuse, or\nchanged-input replay forbids release and all later dispatch.\n\nCleanup uses guarded release only:\n\n```\nworktree_manage({\n  operation: \"release\",\n  handle: <retained opaque handle>,\n  terminalDisposition: \"done\",\n  resultCommit: <merged tip>,\n  deleteBranch: true\n})\n```\n\nA failed harvest or release guard preserves the tree and any side recovery ref.\nNever raw-remove or prune outside guarded release. Successful terminal flow\nreleases once: Remove its worktree, delete its\nderived branch, and prune worktree metadata through that single guarded release.\n\nFor each linked defect, collect all fix tasks from the defect's task\ndependencies and reverse task links. When all are `done`, set the defect\n`resolved` with a concise fix summary. A discovered task in `planned`, `wip`,\nor `blocked` prevents resolution; never treat task discovery as task completion.\n\nDisapproved review rounds remain protected attempt receipts; file their\nquestions/defects through the existing typed owner-scoped paths. Only\n`record_implementation_completion` creates the terminal go-ahead review for a\nmerged implementation. Generic writes cannot terminalize a Git-producing task\nor create, attach, alter, supersede, or terminalize `implementationEvidence`.\n\nRe-derive the ready set after every merge and continue until drained.\n\n## 8. Milestones and goals\n\nFor each touched milestone, close and archive it only when every contained item\nis terminal and, for a coordination milestone, its goal is also terminal.\nPerform `update_item(ledger_id: \"milestones\", ..., status: \"done\")` before\n`archive_milestone(...)`.\n\nNever auto-close a goal. When all of a goal's work milestones are archived,\nreport that the user may set the goal to `done`; a later sweep may then archive\nits coordination milestone.\n\n## Report and handoff\n\nReport merged tasks and commits, blocked tasks and question ids, failed paths,\narchived milestones, and goals ready for user closure.\n\nWhen invoked standalone, write exactly one append-only `handoffs` item:\n\n- `drained`: no reachable task remains;\n- `answers-required`: tasks are blocked on open questions;\n- `user-action-required`: a named task needs a specific external action only\n  the user can perform;\n- `mixed`: several stop causes coexist;\n- `illness-detected`: a protocol, merge, or invariant failure prevents\n  progress.\n\nSet `flow: \"implement\"`, relevant `ledgerRefs`, required\n`blockingQuestions`/`handoffReasons`, and pass log paths. Do not write a\nhandoff for an ordinary context-window interruption. Never stop because of\nelapsed effort, task count, or remaining work size.\n\nWhen invoked inline by another flow, suppress this handoff; the outermost\ncommand owns it.",
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
    promptTemplate: "## Catalogue\n```yaml\ninputs:\n  - \"goal, grounding, full answered-question history, current plan DAG, and prior reviews\"\noutputs:\n  - \"one fenced structured verdict\"\nioSchema:\n  - \"{summary,verdict:go-ahead|revise,new_questions[],criticism[],defects[]}\"\n```\n\nReview the plan against the goal, every answered question, and the actual\nrepository. Judge:\n\n- task granularity and bounded scope;\n- correct milestone/task dependency order;\n- concrete, observable acceptance criteria;\n- grounding in real code and constraints;\n- completeness against the goal.\n\nWhen a task declares an expected failure, require §6a of the implementation\norchestrator. Forms (a) and (b) use the annotation, live marker, and inventory\nentry; form (c) needs no marker. The planned fix must replace a marker with a\nsame-titled plain test and remove the annotation and inventory entry. Reject a\nplan that permits triple co-deletion without that plain test or requires a red\nfull gate.\n\nClassify each finding once:\n\n- `new_questions`: user-only requirements or preferences;\n- `criticism`: plan defects the planner can correct;\n- `defects`: out-of-scope or pre-existing repository faults, independent of\n  the plan verdict.\n\nA discoverable fact is not a user question. A confirmed fault is not a\nfix-versus-ignore question.\n\n```json\n{\n  \"summary\": \"<one-line verdict>\",\n  \"verdict\": \"go-ahead | revise\",\n  \"new_questions\": [\"<user-only question>\"],\n  \"criticism\": [\"<planner-fixable plan defect>\"],\n  \"defects\": [\n    {\n      \"headline\": \"<out-of-scope fault>\",\n      \"severity\": \"low | medium | high | critical\",\n      \"rootCause\": \"<optional>\",\n      \"suggestedFix\": \"<optional>\"\n    }\n  ]\n}\n```\n\n`go-ahead` requires empty question and criticism buckets. `revise` requires at\nleast one. Defects never determine the verdict.\n\nWhen a writer persists `defects` in a review item, validate the complete batch,\nconstruct objects in property order `headline`, `severity`, optional\n`rootCause`, optional `suggestedFix`, and compact-serialize each. Consumers\nmust parse and canonically reconstruct the entire batch before side effects.\n\nWrite nothing. End with the fenced JSON object.",
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
  "task specification, worktree/branch/full-SHA base, worker result, round, and prior criticism"
],
    outputs: [
  "one fenced structured verdict"
],
    ioSchema: [
  "{taskId,verdict,criticism[],questions[],defects[],rationale,gateReRan,resultCommitVerified,resultCommitEvidence,baseAncestry,gateDurationMs?,gateReRanReason?,summary?}"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"task specification, worktree/branch/full-SHA base, worker result, round, and prior criticism\"\noutputs:\n  - \"one fenced structured verdict\"\nioSchema:\n  - \"{taskId,verdict,criticism[],questions[],defects[],rationale,gateReRan,resultCommitVerified,resultCommitEvidence,baseAncestry,gateDurationMs?,gateReRanReason?,summary?}\"\n```\n\nReview one implementation against the actual diff and task acceptance. Verify:\n\nThe supplied `taskId` is the only prepared target. Do not select, fetch, or\nsubstitute another ledger target; this portable reviewer has no ledger write\nauthority.\n\n- acceptance through its named command, output, or invariant;\n- **result-commit evidence:** `git cat-file -t <resultCommit>` is\n  `commit`, and `git rev-parse --verify <branch>` full SHA equals\n  `resultCommit`. On success\n  `resultCommitEvidence: { status: \"verified\", resultCommit, branchTip }` with\n  full SHAs and `resultCommitVerified: true`. On failure\n  `resultCommitVerified: false` and unresolvable evidence with a closed reason\n  and nullable observed SHAs — never invent a SHA;\n- **base-ancestry evidence:** resolve dispatch `baseCommit`, compute\n  `merge-base`, and require\n  `git merge-base --is-ancestor <baseCommit> <resultCommit>`. On success\n  `baseAncestry: { status: \"verified\", relation, baseCommit, resultCommit,\n  mergeBase }` with full SHAs. On failure unresolvable evidence with a closed\n  reason (`not-ancestor` vs missing/non-commit objects). Approval requires both\n  verified arms;\n- gate evidence: either re-run `bun run check` with the foreground process's\n  real status and measured duration, or — when the dispatch carries\n  `parentGateAttestation` on the sandbox-denied path — verify that attestation\n  (`resultCommit` match, `gateExitCode === 0`, `failCount === 0`,\n  `passCount > 0`) and set `gateReRan=false` with\n  `gateReRanReason=sandbox-denied-primitives` instead of invoking `cq gate`;\n- correctness, boundary handling, type safety, and surgical scope;\n- defect-fix reproduction and regression coverage.\n\nFor a task that declares an expected failure, apply §6a of the implementation\norchestrator. Forms (a) and (b) require the annotation, live marker, and\ninventory entry; form (c) needs no marker. A completed fix replaces the marker\nwith a same-titled plain test and removes the annotation and inventory entry.\nReject co-deletion of that triple when no same-titled plain test remains, and\nnever approve a red full gate.\n\nClassify each finding once:\n\n- `criticism`: objective defects the worker can fix;\n- `questions`: unresolved user-only requirements or product choices;\n- `defects`: out-of-scope or pre-existing faults for separate work.\n\nDiscoverable facts, scope magnitude, and whether to fix a confirmed fault are\nnot questions.\n\n```json\n{\n  \"taskId\": \"<task id>\",\n  \"verdict\": \"approve | disapprove\",\n  \"criticism\": [\"<worker-fixable defect>\"],\n  \"questions\": [\"<user-only ambiguity>\"],\n  \"defects\": [\n    {\n      \"headline\": \"<out-of-scope fault>\",\n      \"description\": \"<evidence and scope boundary>\",\n      \"severity\": \"low | medium | high | critical\",\n      \"suggestedFix\": \"<optional>\"\n    }\n  ],\n  \"rationale\": \"<decisive evidence>\",\n  \"gateReRan\": true,\n  \"resultCommitVerified\": true,\n  \"resultCommitEvidence\": {\n    \"status\": \"verified\",\n    \"resultCommit\": \"<40-hex>\",\n    \"branchTip\": \"<40-hex>\"\n  },\n  \"baseAncestry\": {\n    \"status\": \"verified\",\n    \"relation\": \"equal | descendant\",\n    \"baseCommit\": \"<40-hex>\",\n    \"resultCommit\": \"<40-hex>\",\n    \"mergeBase\": \"<40-hex>\"\n  },\n  \"gateDurationMs\": 12345,\n  \"summary\": \"<optional one-line verdict>\"\n}\n```\n\nAlways state `gateReRan`, `resultCommitVerified`, `resultCommitEvidence`, and\n`baseAncestry`. Include `gateDurationMs` only when the gate ran; otherwise\ninclude an optional `gateReRanReason` (exactly `sandbox-denied-primitives` on\nthe parent-attested path). Approval requires empty criticism/questions, a green\ngate (child re-run or verified parent attestation), verified result commit, and\nverified base ancestry with full SHAs. Disapproval requires criticism or\nquestions and may carry unresolvable evidence. Defects do not control the\nverdict.\n\nWrite nothing. Give a brief session summary, then end with the fenced object.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"natural-language alias list or adapter:model tokens\"\noutputs:\n  - \"resolved session-only planner set; no durable write\"\nioSchema:\n  - \"cq.toml aliases take precedence; unknown aliases fail explicitly\"\n```\n\nParse `$ARGUMENTS` into planner aliases/tokens. Resolve named aliases from the\nconfigured `aliases` section, case-insensitively. If alias configuration is\nunavailable, reject aliases explicitly. Accept an explicit `adapter:model`\ntoken verbatim. Report every unknown alias; never silently drop it.\n\nEcho the original instruction, resolution source, ordered alias-to-token\nmapping, and canonical token list. State that the override lives only in the\ncurrent chained run, writes no file or ledger item, and reverts on a fresh run\nto the LIST-KEYED planner panel (the `planners` section of configuration):\n\n- `configured: true` only when the resolved `planners` list is non-empty;\n- `configured: false` when cq.toml is absent or `planners = []`, in which case\n  the payload still carries the built-in `DEFAULT_PLANNERS` fallback tokens\n  (grammar-valid, dispatchable) so orchestrators do not invent a model.\n\nDo not confuse this with the all-config presence-only `configured` flag (a\nparseable cq.toml exists). Panel tools are list-keyed; the all-config tool is\npresence-keyed. The plan orchestrator uses this in-memory set before consulting\nthe planner panel.",
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
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"natural-language alias list or adapter:model tokens\"\noutputs:\n  - \"resolved session-only reviewer set; no durable write\"\nioSchema:\n  - \"cq.toml aliases take precedence; unknown aliases fail explicitly\"\n```\n\nParse `$ARGUMENTS` into reviewer aliases/tokens. Resolve named aliases from the\nconfigured `aliases` section, case-insensitively. If alias configuration is\nunavailable, reject aliases explicitly. Accept an explicit `adapter:model`\ntoken verbatim. Report every unknown alias; never silently drop it.\n\nEcho the original instruction, resolution source, ordered alias-to-token\nmapping, and canonical token list. State that the override lives only in the\ncurrent chained run, writes no file or ledger item, and reverts on a fresh run\nto the LIST-KEYED reviewer panel (the `reviewers` section of configuration):\n\n- `configured: true` only when the resolved `reviewers` list is non-empty;\n- `configured: false` when cq.toml is absent or `reviewers = []`, in which case\n  the payload still carries the built-in `DEFAULT_REVIEWERS` fallback tokens\n  (grammar-valid, dispatchable) so orchestrators do not invent a model.\n\nDo not confuse this with the all-config presence-only `configured` flag (a\nparseable cq.toml exists). Panel tools are list-keyed; the all-config tool is\npresence-keyed. The plan and implement orchestrators use this in-memory set\nbefore consulting the reviewer panel.",
    privilege: "RO",
    exposedTools: "none declared",
  },
  {
    id: "upstream",
    name: "/cq:upstream",
    kind: "orchestrator",
    source: "commands/cq/upstream.md",
    description: "File or recheck one ordinary GitHub upstream item, or batch-recheck at most 10.",
    inputs: [
  "optional upstream id U<n>; empty means batch-recheck"
],
    outputs: [
  "at most one authorized filing claim, or a bounded recheck plan, then token-validated bookkeeping"
],
    ioSchema: [
  "explicit U<n> may file or recheck; no-id batch never files"
],
    promptTemplate: "{{cq:fragment:cq-command-invocation}}\n{{cq:fragment:ledger-response-contract}}\n\n## Catalogue\n```yaml\ninputs:\n  - \"optional upstream id U<n>; empty means batch-recheck\"\noutputs:\n  - \"at most one authorized filing claim, or a bounded recheck plan, then token-validated bookkeeping\"\nioSchema:\n  - \"explicit U<n> may file or recheck; no-id batch never files\"\n```\n\nThis is a single-shot non-flow command. There is no `:advance`, no `pUpstream`,\nand no sequencer stage.\n\nRead `get_config` section `all` and honor `[upstream]` kill-switches\n(default enabled). `filing` gates only explicit-id prepare-to-file.\n`recheck` gates recheck. Credentials never come from cq.toml.\n\n## Modes\n\n### `CQ::upstream U<n>`\n\nFetch `upstream:U<n>`.\n\n- `open` + filing enabled → prepare a filing claim (`filingOperationId`,\n  `filingState=claimed`, `filingClaimedAt`) via `update_item`. Only the\n  winner of that compare-and-set may submit. If already claimed, stop and\n  reconcile; do not file.\n- `reported` / `accepted` / `fixed-upstream` + recheck enabled → recheck.\n- `released` / `wontfix` → no-op.\n\n### `CQ::upstream` (no id)\n\nBatch-recheck only. Select at most 10 items: never-checked first, then\noldest `lastCheckedAt`, then id. Never file. If recheck is disabled, stop.\n\n## Fail-closed before observation\n\nDo not observe or mutate when:\n\n- `reportingClassification` is missing, uncertain, or not exactly `ordinary`\n- `trackerKind` is not exactly `github`\n\nPrint manual instructions and leave every item byte unchanged.\n\n## Observations\n\nHost tools gather evidence. Then apply only these mutations:\n\n- attempted auth / private / rate / offline / 5xx / ambiguous →\n  `lastCheckedAt` + `lastCheckOutcome` only\n- confirmed report URL → may add `reportUrls` / `trackingUrl` and\n  `open`→`reported` when the claim token matches\n- confirmed upstream release → `fixed-upstream`/`accepted`/`reported`→`released`\n- unknown submission outcome → `filingState=reconciliation-required`;\n  keep the claim; search open+closed reports before any retry\n- never apply a generic unguarded status rewrite that skips the claim token\n\nLog the session with `cq log put`. Sanitize evidence. Do not store tokens.",
    privilege: "RO",
    exposedTools: "none declared",
  },
];
