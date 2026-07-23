// gemini-2.5-flash-lite has the highest free-tier quota (15 RPM / 1,000 RPD)
// You can override with GEMINI_MODEL env var
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const GEMINI_API_URL_TEMPLATE = `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`;

const SYSTEM_PROMPT = `You are an AI agent that helps manage Linear issues and GitHub pull requests.

You can:
- Fetch Linear issues by ID or get the latest issue
- List recent Linear issues
- Create GitHub pull requests for Linear issues
- Get repository information

When a user asks you to do something, use the appropriate tool to accomplish the task.
Always explain what you're doing and provide clear feedback about the results.

If you need more information to complete a task, ask the user for clarification.

If a request is outside what you can do (it doesn't match any of your tools or the
configuration available to you), say so plainly, for example: "I can't answer this
— I don't have this configured." Do not guess or fabricate an answer for something
you have no way to actually do.

Be helpful, concise, and professional.`;

// Short, terse system prompt on purpose: this runs on every Linear create/update
// webhook, so the output is capped hard (maxOutputTokens below) to keep each call
// cheap against the free-tier quota.
const TRIAGE_SYSTEM_PROMPT = `You are an engineering triage agent reviewing a Linear issue.

Decide whether the issue clearly describes a coding/implementation task -- something
an engineer would write or change code for.

- If yes: call write_pseudocode with a "sketch" argument of 3 to 5 lines -- line 1 a
  function name/signature capturing the core action, the rest short pseudocode steps.
  No real syntax, no prose, no markdown fences.
- If it is not clearly a coding task (vague, a question, research/design/docs/process
  item, or anything you're not confident is implementation work): call write_greeting
  with no arguments.

You must call exactly one of these two tools. Never respond with plain text.`;

const TRIAGE_TOOLS = [
  {
    name: "write_pseudocode",
    description: "Record a minimal pseudocode implementation sketch for a coding task.",
    parameters: {
      type: "object",
      properties: {
        sketch: {
          type: "string",
          description: "3 to 5 lines: a function name/signature line followed by short pseudocode steps.",
        },
      },
      required: ["sketch"],
    },
  },
  {
    name: "write_greeting",
    description: "Use when the issue is not clearly a coding/implementation task.",
    parameters: { type: "object", properties: {} },
  },
];

// Forces a function call (mode: "ANY") rather than letting the model reply with
// text -- the whole point is that this is a tool-calling decision, not a completion.
export async function triageIssue(apiKey, issue) {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const apiUrl = GEMINI_API_URL_TEMPLATE.replace("{model}", model);
  const userText = `Title: ${issue.title}\nDescription: ${issue.description?.trim() || "(no description provided)"}`;

  const requestBody = {
    contents: [{ role: "user", parts: [{ text: userText }] }],
    systemInstruction: { parts: [{ text: TRIAGE_SYSTEM_PROMPT }] },
    tools: [{ functionDeclarations: TRIAGE_TOOLS }],
    toolConfig: {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["write_pseudocode", "write_greeting"],
      },
    },
    generationConfig: { maxOutputTokens: 200, temperature: 0.2 },
  };

  const response = await fetch(`${apiUrl}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const call = parts.find((p) => p.functionCall)?.functionCall;
  if (!call) throw new Error("Gemini did not return a tool call");
  return { name: call.name, args: call.args || {} };
}

export class GeminiLLM {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.history = [];
    this.model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    this.apiUrl = GEMINI_API_URL_TEMPLATE.replace("{model}", this.model);
  }

  async chat(userMessage, tools = []) {
    this.history.push({ role: "user", content: userMessage });

    const requestBody = {
      contents: this.history.map((msg) => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      })),
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
    };

    const response = await fetch(`${this.apiUrl}?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let text = "";
    const functionCalls = [];

    for (const part of parts) {
      if (part.text) {
        text += part.text;
      }
      if (part.functionCall) {
        functionCalls.push(part.functionCall);
      }
    }

    if (text) {
      this.history.push({ role: "assistant", content: text });
    }

    return { text, functionCalls };
  }

  clearHistory() {
    this.history = [];
  }
}
