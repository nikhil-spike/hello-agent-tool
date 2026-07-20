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
