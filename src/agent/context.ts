import type { NormalizedResult } from "../types.js";

/**
 * Source tracked during research.
 */
export interface Source {
  url: string;
  title: string;
  snippet: string;
  accessedAt: Date;
}

/**
 * Research step/operation record.
 */
export interface ResearchStep {
  type: "search" | "fetch" | "refine" | "synthesize";
  description: string;
  timestamp: Date;
  /** Run ID this step belongs to (present for agent-run steps). */
  run_id?: string;
  outcome?: "success" | "failed";
  duration_ms?: number;
  error?: string;
}

/**
 * Research context maintained across agent steps.
 */
export class ResearchContext {
  goal: string;
  sources: Source[] = [];
  steps: ResearchStep[] = [];
  /** Tracked so tools can reference the active query */
  currentQuery: string = "";
  maxSources: number;
  /** Agent run ID correlated across steps and agent-triggered usage entries. */
  runId?: string;

  constructor(goal: string, maxSources: number = 5, runId?: string) {
    this.goal = goal;
    this.maxSources = maxSources;
    this.runId = runId;
  }

  /**
   * Add a source if not already tracked.
   */
  addSource(result: NormalizedResult): void {
    const exists = this.sources.some(
      (s) => s.url.toLowerCase() === result.url.toLowerCase()
    );
    
    if (!exists && this.sources.length < this.maxSources) {
      this.sources.push({
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        accessedAt: new Date(),
      });
    }
  }

  /**
   * Record a research step.
   */
  addStep(type: ResearchStep["type"], description: string): ResearchStep {
    const step: ResearchStep = {
      type,
      description,
      timestamp: new Date(),
      ...(this.runId ? { run_id: this.runId } : {}),
    };
    this.steps.push(step);
    return step;
  }

  completeStep(
    step: ResearchStep,
    outcome: "success" | "failed",
    durationMs: number,
    error?: string
  ): void {
    step.outcome = outcome;
    step.duration_ms = Math.max(0, Math.round(durationMs));
    if (error) step.error = error;
  }

  /**
   * Get formatted sources for citation.
   */
  getFormattedSources(): string {
    return this.sources
      .map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`)
      .join("\n");
  }

  /**
   * Generate final response with source citations appended.
   */
  generateResponse(answer: string): {
    answer: string;
    sources: Source[];
    steps: ResearchStep[];
  } {
    const citationBlock = this.sources.length > 0
      ? "\n\nSources:\n" + this.getFormattedSources()
      : "";

    return {
      answer: answer + citationBlock,
      sources: this.sources,
      steps: this.steps,
    };
  }
}
