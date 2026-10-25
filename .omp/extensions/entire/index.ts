import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";

// entire-agent-omp: project-local Entire integration for omp.
export default function entireAgent(pi: ExtensionAPI): void {
  let turnOpen = false;
  let pendingPrompt: string | undefined;
  let runEnd: Promise<boolean> | undefined;
  let resolveRunEnd: ((willContinue: boolean) => void) | undefined;
  let deferredEnd: Record<string, unknown> | undefined;
  let turnIdentity: Record<string, unknown> | undefined;
  let sessionGeneration = 0;

  function armRunEnd(): Promise<boolean> {
    if (!runEnd) {
      runEnd = new Promise((resolve) => {
        resolveRunEnd = resolve;
      });
    }
    return runEnd;
  }

  function settleRunEnd(willContinue: boolean): void {
    resolveRunEnd?.(willContinue);
    resolveRunEnd = undefined;
  }

  async function crossRunEnd(): Promise<boolean | undefined> {
    const generation = sessionGeneration;
    const barrier = armRunEnd();
    const willContinue = await barrier;
    if (generation !== sessionGeneration) return undefined;
    if (runEnd === barrier) runEnd = undefined;
    return willContinue;
  }

  function runHook(name: string, payload: Record<string, unknown>, timeout = 10_000): Promise<void> {
    return new Promise((resolve) => {
      let body: string;
      try {
        body = JSON.stringify(payload);
      } catch {
        resolve();
        return;
      }
      try {
        const child = execFile(
          "entire",
          ["hooks", "omp", name],
          { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          () => resolve(),
        );
        child.stdin?.on("error", () => resolve());
        child.stdin?.end(body);
      } catch {
        resolve();
      }
    });
  }

  function runHookSync(name: string, payload: Record<string, unknown>, timeout = 10_000): void {
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch {
      return;
    }
    try {
      execFileSync(
        "entire",
        ["hooks", "omp", name],
        { input: body, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch {
      // Hook failures must not terminate omp.
    }
  }

  async function startSession(_event: unknown, ctx: ExtensionContext): Promise<void> {
    const previousEnd = turnOpen ? armRunEnd() : undefined;
    sessionGeneration++;
    pendingPrompt = undefined;
    if (previousEnd) {
      const willContinue = await previousEnd;
      if (willContinue && deferredEnd) runHookSync("agent_end", deferredEnd);
    }
    turnOpen = false;
    runEnd = undefined;
    resolveRunEnd = undefined;
    deferredEnd = undefined;
    turnIdentity = undefined;
    await runHook("session_start", {
      type: "session_start",
      cwd: ctx.cwd,
      session_id: ctx.sessionManager.getSessionId(),
      session_file: ctx.sessionManager.getSessionFile(),
    });
  }

  pi.on("session_start", startSession);
  pi.on("session_switch", startSession);
  pi.on("session_branch", startSession);

  pi.on("before_agent_start", (event) => {
    pendingPrompt = event.prompt;
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (pendingPrompt === undefined) {
      if (!turnOpen) return;
      const willContinue = await crossRunEnd();
      if (willContinue) {
        deferredEnd = undefined;
        armRunEnd();
      }
      return;
    }
    const prompt = pendingPrompt;
    pendingPrompt = undefined;
    if (turnOpen) {
      const willContinue = await crossRunEnd();
      if (willContinue === undefined) return;
      if (willContinue) {
        deferredEnd = undefined;
        armRunEnd();
        return;
      }
    }
    runEnd = undefined;
    deferredEnd = undefined;
    turnIdentity = {
      cwd: ctx.cwd,
      session_id: ctx.sessionManager.getSessionId(),
      session_file: ctx.sessionManager.getSessionFile(),
    };
    runHookSync("agent_start", {
      type: "agent_start",
      ...turnIdentity,
      prompt,
    });
    turnOpen = true;
    armRunEnd();
  });

  pi.on("agent_end", (event) => {
    if (!turnOpen || !turnIdentity) return;
    const willContinue = event.willContinue === true;
    const endPayload = {
      type: "agent_end",
      ...turnIdentity,
      model: (event.messages.findLast((message) => message.role === "assistant") as
        { model?: string } | undefined)?.model,
    };
    if (!willContinue) {
      runHookSync("agent_end", endPayload);
      turnOpen = false;
      deferredEnd = undefined;
      turnIdentity = undefined;
    } else {
      deferredEnd = endPayload;
    }
    settleRunEnd(willContinue);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runHook("session_shutdown", {
      type: "session_shutdown",
      cwd: ctx.cwd,
      session_id: ctx.sessionManager.getSessionId(),
      session_file: ctx.sessionManager.getSessionFile(),
    }, 1_500);
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash" || typeof event.input?.command !== "string") return;
    if (/(^|\s)GIT_TERMINAL_PROMPT\s*=/.test(event.input.command)) return;
    event.input.command = `export GIT_TERMINAL_PROMPT=0
${event.input.command}`;
  });
}
