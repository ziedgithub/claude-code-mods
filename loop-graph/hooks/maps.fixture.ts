// The setup skill's two example maps (skills/setup/examples), for the tests.
import type { LoopMap } from './graph'

export const DEV_LOOP: LoopMap = {
  "name": "Dev loop",
  "lanes": [
    {
      "id": "express",
      "label": "Express lane"
    },
    {
      "id": "standard",
      "label": "Standard lane"
    },
    {
      "id": "complete",
      "label": "Complete lane"
    }
  ],
  "steps": [
    {
      "id": "dev.triage",
      "label": "Triage",
      "role": "/dev",
      "kind": "switch",
      "what": "Reads the task, counts what it will touch, picks a lane on fixed criteria.",
      "short": "Picks the lane from what the task touches",
      "span": true,
      "opens": true
    },
    {
      "id": "quick.frame",
      "label": "Frame",
      "role": "/quick",
      "kind": "self",
      "what": "Notes the start time, checks the debt ledger and the express envelope.",
      "short": "Checks the task fits the express lane",
      "lanes": [
        "express"
      ],
      "col": 0,
      "opens": true
    },
    {
      "id": "quick.test",
      "label": "Test first",
      "role": "red, then green",
      "kind": "self",
      "what": "Writes the failing test, runs it alone, sees it red, then makes it pass.",
      "short": "A failing test first, then make it pass",
      "lanes": [
        "express"
      ],
      "col": 0
    },
    {
      "id": "quick.build",
      "label": "Build + tests",
      "role": "gate runner",
      "kind": "self",
      "what": "Filtered static analysis, then the package's tests.",
      "short": "Static analysis, then the package's tests",
      "lanes": [
        "express"
      ],
      "col": 0
    },
    {
      "id": "quick.clean",
      "label": "Clean up",
      "role": "simplify axes",
      "kind": "self",
      "what": "Applies reuse / simplification / efficiency to the production files.",
      "short": "Simplifies the changed production code",
      "lanes": [
        "express"
      ],
      "col": 0
    },
    {
      "id": "quick.review",
      "label": "Second look",
      "role": "quick review agent",
      "kind": "agent",
      "what": "One review of the diff for confirmed correctness defects only.",
      "short": "One agent reviews the diff for real bugs",
      "lanes": [
        "express"
      ],
      "col": 0
    },
    {
      "id": "quick.recount",
      "label": "Recount",
      "role": "envelope on the diff",
      "kind": "self",
      "what": "Counts the real diff against the envelope; exceeded means leaving for the full loop.",
      "short": "Checks the real diff still fits express",
      "lanes": [
        "express"
      ],
      "col": 0
    },
    {
      "id": "quick.cost",
      "label": "Record cost",
      "role": "loop report",
      "kind": "self",
      "what": "Writes the token and time breakdown of this run.",
      "short": "Writes this run's token and time report",
      "lanes": [
        "express"
      ],
      "col": 0
    },
    {
      "id": "quick.finish",
      "label": "Finish",
      "role": "diff left pending",
      "kind": "end",
      "what": "Closing recap; the diff stays uncommitted for you.",
      "short": "Recap; the diff is left for you",
      "lanes": [
        "express"
      ],
      "col": 0
    },
    {
      "id": "orch.intake",
      "label": "Intake",
      "role": "card + branch",
      "kind": "self",
      "what": "Reads the card, moves it to In progress, writes the feature file, makes the branch.",
      "short": "Card to In progress, feature file, branch",
      "col": 1,
      "opens": true
    },
    {
      "id": "orch.startup",
      "label": "Startup",
      "role": "init.sh baseline",
      "kind": "self",
      "what": "Runs the harness checks and every fast gate once, recording the baseline.",
      "short": "Every fast gate once: the baseline",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1
    },
    {
      "id": "orch.plan",
      "label": "Plan",
      "role": "planner",
      "kind": "agent",
      "what": "Interviews you (one round in standard), then writes a test-first plan in slices.",
      "short": "Planner asks, then writes a sliced test-first plan",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1
    },
    {
      "id": "orch.plan-gate",
      "label": "Plan gate",
      "role": "you approve",
      "kind": "human",
      "what": "You approve, cancel or send feedback on the plan. Nothing is coded before.",
      "short": "You approve, amend or cancel the plan",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1
    },
    {
      "id": "orch.implement",
      "label": "Implement",
      "role": "implementer",
      "kind": "agent",
      "what": "One fresh implementer per slice, red then green, with a work-in-progress commit.",
      "short": "One implementer per slice: red, then green",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1,
      "multi": true
    },
    {
      "id": "orch.simplify",
      "label": "Simplify",
      "role": "simplify-cleaner",
      "kind": "agent",
      "what": "Cleans the whole diff once every slice is green, before the reviewers.",
      "short": "Cleans the whole diff once every slice is green",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1
    },
    {
      "id": "orch.reviewers",
      "label": "Reviewer gate",
      "role": "specialist reviewers",
      "kind": "agent",
      "what": "Specialist reviewers fire on strict file patterns, at most two rounds.",
      "short": "Specialist reviewers check the diff",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1,
      "multi": true,
      "maxVisits": 2
    },
    {
      "id": "orch.device",
      "label": "Phone check",
      "role": "device-checker",
      "kind": "agent",
      "what": "A screen change is installed on your phone and each state it shows is compared with its design.",
      "short": "The screen change is checked on your phone",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1
    },
    {
      "id": "orch.evaluate",
      "label": "Evaluate",
      "role": "evaluator",
      "kind": "agent",
      "what": "Re-runs the gates independently and scores the rubric: accept, revise or block.",
      "short": "Re-runs every gate and scores the change",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1,
      "multi": true
    },
    {
      "id": "orch.debt",
      "label": "Debt ledger",
      "role": "orchestrator",
      "kind": "self",
      "what": "Settles reported tech debt before any accept.",
      "short": "Settles the tech debt the run reported",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1
    },
    {
      "id": "orch.final-gate",
      "label": "Final gate",
      "role": "you approve",
      "kind": "human",
      "what": "You approve the commit, stop, or ask for a fix.",
      "short": "You approve the commit, stop or ask a fix",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1
    },
    {
      "id": "orch.closure",
      "label": "Closure",
      "role": "ship + loop report",
      "kind": "agent",
      "what": "A fresh agent squashes into one commit, moves the card to Done and writes the report.",
      "short": "One commit, card to Done, loop report",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1
    },
    {
      "id": "orch.done",
      "label": "Done",
      "role": "committed or blocked",
      "kind": "end",
      "what": "The run is over.",
      "short": "The run is over",
      "lanes": [
        "standard",
        "complete"
      ],
      "col": 1
    }
  ],
  "arcs": [
    {
      "from": "dev.triage",
      "to": "quick.frame",
      "label": "express",
      "lane": "express"
    },
    {
      "from": "dev.triage",
      "to": "orch.intake",
      "label": "standard",
      "lane": "standard"
    },
    {
      "from": "dev.triage",
      "to": "orch.intake",
      "label": "complete",
      "lane": "complete"
    },
    {
      "from": "quick.frame",
      "to": "quick.test",
      "label": "inside envelope"
    },
    {
      "from": "quick.test",
      "to": "quick.build",
      "label": "seen red, then green"
    },
    {
      "from": "quick.build",
      "to": "quick.clean",
      "label": "no regressions"
    },
    {
      "from": "quick.clean",
      "to": "quick.review",
      "label": "cleaned"
    },
    {
      "from": "quick.review",
      "to": "quick.recount",
      "label": "defects fixed"
    },
    {
      "from": "quick.recount",
      "to": "quick.cost",
      "label": "still fits"
    },
    {
      "from": "quick.cost",
      "to": "quick.finish",
      "label": "cost recorded"
    },
    {
      "from": "quick.frame",
      "to": "orch.intake",
      "label": "outside envelope"
    },
    {
      "from": "quick.recount",
      "to": "orch.intake",
      "label": "envelope exceeded"
    },
    {
      "from": "orch.intake",
      "to": "orch.startup",
      "label": "card ready"
    },
    {
      "from": "orch.startup",
      "to": "orch.plan",
      "label": "baseline green"
    },
    {
      "from": "orch.plan",
      "to": "orch.plan-gate",
      "label": "plan written"
    },
    {
      "from": "orch.plan-gate",
      "to": "orch.implement",
      "label": "approved"
    },
    {
      "from": "orch.implement",
      "to": "orch.implement",
      "label": "next slice"
    },
    {
      "from": "orch.implement",
      "to": "orch.simplify",
      "label": "all slices green"
    },
    {
      "from": "orch.simplify",
      "to": "orch.reviewers",
      "label": "diff cleaned"
    },
    {
      "from": "orch.reviewers",
      "to": "orch.device",
      "label": "no CRITICAL · screen changed"
    },
    {
      "from": "orch.device",
      "to": "orch.evaluate",
      "label": "phone checked"
    },
    {
      "from": "orch.reviewers",
      "to": "orch.evaluate",
      "label": "no screen change"
    },
    {
      "from": "orch.evaluate",
      "to": "orch.debt",
      "label": "ACCEPT"
    },
    {
      "from": "orch.debt",
      "to": "orch.final-gate",
      "label": "ledger settled"
    },
    {
      "from": "orch.final-gate",
      "to": "orch.closure",
      "label": "approved"
    },
    {
      "from": "orch.closure",
      "to": "orch.done",
      "label": "shipped / reported"
    },
    {
      "from": "orch.plan-gate",
      "to": "orch.plan",
      "label": "feedback"
    },
    {
      "from": "orch.implement",
      "to": "orch.plan",
      "label": "PLAN-DEVIATION"
    },
    {
      "from": "orch.reviewers",
      "to": "orch.implement",
      "label": "[BLOCKING] fix"
    },
    {
      "from": "orch.evaluate",
      "to": "orch.implement",
      "label": "REVISE"
    },
    {
      "from": "orch.final-gate",
      "to": "orch.implement",
      "label": "fix asked"
    },
    {
      "from": "orch.implement",
      "to": "orch.reviewers",
      "label": "fix pass · gate run again"
    },
    {
      "from": "orch.implement",
      "to": "orch.device",
      "label": "fix pass · screen changed"
    },
    {
      "from": "orch.implement",
      "to": "orch.evaluate",
      "label": "fix pass · no screen change"
    },
    {
      "from": "orch.plan-gate",
      "to": "orch.closure",
      "label": "cancel"
    },
    {
      "from": "orch.reviewers",
      "to": "orch.closure",
      "label": "CRITICAL: block"
    },
    {
      "from": "orch.evaluate",
      "to": "orch.closure",
      "label": "BLOCK"
    }
  ],
  "outcomes": [
    {
      "match": "^SLICE: GREEN\\b.*?TESTS: (\\d+)/(\\d+)",
      "text": "green · $1/$2 tests"
    },
    {
      "match": "^SLICE: RED\\b.*?TESTS: (\\d+)/(\\d+)",
      "text": "red · $1/$2 tests",
      "bad": "^red"
    },
    {
      "match": "^FINDINGS: CRITICAL=(\\d+) HIGH=(\\d+)",
      "text": "$1 critical · $2 high",
      "bad": "^[1-9]"
    },
    {
      "match": "^VERDICT: (\\w+).*?SCORE: (\\d+/\\d+)",
      "text": "$1 · $2",
      "bad": "^BLOCK"
    },
    {
      "match": "^VERDICT: (\\w+)",
      "text": "$1",
      "bad": "^BLOCK"
    },
    {
      "match": "^SIMPLIFY: (changed|unchanged)",
      "text": "$1"
    },
    {
      "match": "^DEVICE: (PASS|GAPS=\\d+|UNAVAILABLE)",
      "text": "phone: $1",
      "bad": "GAPS|UNAVAILABLE"
    },
    {
      "match": "^CLOSURE: pr=(\\w+)",
      "text": "closure: $1",
      "bad": "failed"
    },
    {
      "match": "^PLAN: slices=(\\d+)",
      "text": "$1 slices",
      "agents": [
        "planner"
      ]
    }
  ],
  "runners": [
    {
      "match": "\\+(\\d+)(?: ~\\d+)? -(\\d+): Some tests failed\\.",
      "text": "$2 tests failed",
      "bad": "failed"
    },
    {
      "match": "\\+(\\d+)(?: ~\\d+)?: All tests passed!",
      "text": "$1 tests passed"
    },
    {
      "match": "\\b(\\d+) regressions?\\b",
      "text": "$1 regressions",
      "bad": "."
    },
    {
      "match": "\\bNo regressions\\.",
      "text": "no regressions"
    }
  ],
  "asksBack": [
    {
      "agent": "planner",
      "doneWhen": "Plan ready|plan saved"
    }
  ],
  "reporters": [
    "implementer",
    "simplify-cleaner",
    "evaluator",
    "device-checker"
  ]
}

export const FEATURE_LOOP: LoopMap = {
  "name": "Feature loop",
  "steps": [
    {
      "id": "spec",
      "label": "Spec",
      "role": "you + Claude",
      "kind": "self",
      "what": "Turns the request into acceptance criteria.",
      "short": "Acceptance criteria from the request"
    },
    {
      "id": "build",
      "label": "Build",
      "role": "builder agent",
      "kind": "agent",
      "what": "An agent writes the code and its tests.",
      "short": "An agent writes code and tests"
    },
    {
      "id": "test",
      "label": "Test",
      "role": "npm test",
      "kind": "self",
      "what": "Runs the whole test suite.",
      "short": "Runs the test suite"
    },
    {
      "id": "review",
      "label": "Review",
      "role": "reviewer agent",
      "kind": "agent",
      "what": "A reviewer reads the diff against the criteria.",
      "short": "A reviewer reads the diff"
    },
    {
      "id": "approve",
      "label": "Approve",
      "role": "you decide",
      "kind": "human",
      "what": "You approve the change or send it back.",
      "short": "You approve or send it back"
    },
    {
      "id": "ship",
      "label": "Ship",
      "role": "commit + PR",
      "kind": "end",
      "what": "Commits and opens the pull request.",
      "short": "Commit and pull request"
    }
  ],
  "arcs": [
    {
      "from": "spec",
      "to": "build",
      "label": "criteria agreed"
    },
    {
      "from": "build",
      "to": "test",
      "label": "code written"
    },
    {
      "from": "test",
      "to": "review",
      "label": "tests green"
    },
    {
      "from": "test",
      "to": "build",
      "label": "tests red"
    },
    {
      "from": "review",
      "to": "approve",
      "label": "VERDICT: PASS"
    },
    {
      "from": "review",
      "to": "build",
      "label": "VERDICT: FIX"
    },
    {
      "from": "approve",
      "to": "ship",
      "label": "approved"
    },
    {
      "from": "approve",
      "to": "spec",
      "label": "rethink"
    }
  ],
  "outcomes": [
    {
      "match": "^VERDICT: (\\w+)",
      "text": "$1",
      "bad": "^FIX"
    }
  ],
  "runners": [
    {
      "match": "Tests:\\s+(\\d+) failed",
      "text": "$1 tests failed",
      "bad": "."
    },
    {
      "match": "Tests:\\s+(\\d+) passed",
      "text": "$1 tests passed"
    }
  ],
  "reporters": [
    "reviewer"
  ]
}
