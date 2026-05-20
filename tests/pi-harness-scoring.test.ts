import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type HarnessFailure = "early_completion" | "missing_file_read" | "missing_skill_reference";

type HarnessEvent = {
  type: string;
  name?: string;
  status?: string;
  text?: string;
  arguments?: Record<string, unknown>;
};

type HarnessFixture = {
  caseId: string;
  expectedFailures: HarnessFailure[];
  events: HarnessEvent[];
};

type HarnessScore = {
  passed: boolean;
  score: number;
  failures: HarnessFailure[];
};

const fixtureNames = [
  "pass-baseline.json",
  "early-completion.json",
  "no-file-read.json",
  "no-skill-reference.json"
];

const skillSignals = ["inspection-standard-hierarchy-consultant", "excel-workbook-quality", "skill.md"];

export async function runPiHarnessScoringRegression(): Promise<void> {
  const fixtures = await Promise.all(fixtureNames.map(readFixture));
  const results = fixtures.map((fixture) => ({ fixture, score: scoreHarnessSession(fixture.events) }));

  for (const { fixture, score } of results) {
    assert.deepEqual(score.failures, fixture.expectedFailures, `${fixture.caseId} failure set`);
    assert.equal(score.passed, fixture.expectedFailures.length === 0, `${fixture.caseId} pass state`);
  }

  const baseline = results.find(({ fixture }) => fixture.caseId === "pass-baseline");
  assert.ok(baseline, "pass-baseline fixture is required");

  for (const { fixture, score } of results.filter(({ fixture }) => fixture.caseId !== "pass-baseline")) {
    assert.ok(score.score < baseline.score.score, `${fixture.caseId} should score below baseline`);
  }
}

function scoreHarnessSession(events: HarnessEvent[]): HarnessScore {
  const readIndex = events.findIndex(isTaskManifestRead);
  const skillIndex = events.findIndex(hasSkillReference);
  const completionIndex = events.findIndex(isCompletion);
  const failures: HarnessFailure[] = [];

  if (completionIndex !== -1) {
    const readAfterCompletion = readIndex !== -1 && completionIndex < readIndex;
    const skillAfterCompletion = skillIndex !== -1 && completionIndex < skillIndex;
    if (readAfterCompletion || skillAfterCompletion) failures.push("early_completion");
  }
  if (readIndex === -1) failures.push("missing_file_read");
  if (skillIndex === -1) failures.push("missing_skill_reference");

  return {
    passed: failures.length === 0,
    score: 3 - failures.length,
    failures
  };
}

async function readFixture(name: string): Promise<HarnessFixture> {
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pi-harness-scoring", name);
  return JSON.parse(await fs.readFile(fixturePath, "utf8")) as HarnessFixture;
}

function isTaskManifestRead(event: HarnessEvent): boolean {
  return event.type === "tool_call" && event.name === "read_task_manifest";
}

function hasSkillReference(event: HarnessEvent): boolean {
  const serialized = JSON.stringify(event).toLowerCase();
  return skillSignals.some((signal) => serialized.includes(signal));
}

function isCompletion(event: HarnessEvent): boolean {
  return event.status === "completed" || event.type === "task_completed";
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runPiHarnessScoringRegression();
}
