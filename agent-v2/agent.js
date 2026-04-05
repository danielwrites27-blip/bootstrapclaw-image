// ── AGENT V2: CONTEXT BUILDER ─────────────────────────

const STANDING_RULES = `
You are an autonomous coding agent.

Rules:
- Be precise
- Do not guess
- Fix root problems only
- Do not create new bugs
`;

let taskMemory = {
  goal: "",
  notes: []
};

function buildContext(userInput, history) {

  // Only keep last 5 messages
  const recentHistory = history.slice(-5);

  return {
    system: STANDING_RULES,

    task: taskMemory,

    history: recentHistory,

    input: userInput
  };
}

// ── TEST RUN ─────────────────────────────────────────

const history = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "fix bug" }
];

const context = buildContext("fix login issue", history);

console.log("=== CONTEXT BUILT ===");
console.log(JSON.stringify(context, null, 2));
