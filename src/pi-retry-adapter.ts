import {
  type Api,
  clampThinkingLevel,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface RetryModelCandidate {
  input: string;
  model: Model<Api>;
  thinking?: ModelThinkingLevel;
}

export interface ModelTransition {
  candidate: RetryModelCandidate;
  previous?: Model<Api>;
  thinking: ModelThinkingLevel;
  reason: "fallback" | "override";
  selection?: string[];
}

interface AssistantFailure {
  role: "assistant";
  stopReason?: string;
  errorMessage?: string;
}

interface PrivateAgentSession {
  _handlePostAgentRun(): Promise<boolean>;
  _lastAssistantMessage?: AssistantFailure;
  _isRetryableError(message: AssistantFailure): boolean;
  _omitRecoveryAttempt(message: AssistantFailure): void;
  _emit(event: { type: "thinking_level_changed"; level: ModelThinkingLevel }): void;
  _emitModelSelect(next: Model<Api>, previous: Model<Api> | undefined, source: "set"): Promise<void>;
}

interface InvocationState {
  candidates: RetryModelCandidate[];
  cursor: number;
  transitionsRemaining: number;
  signal?: AbortSignal;
  canFallback?: () => boolean;
  onTransition?: (transition: ModelTransition) => void;
}

interface InstalledAdapter {
  privateSession: PrivateAgentSession;
  original: PrivateAgentSession["_handlePostAgentRun"];
  candidates: RetryModelCandidate[];
  cursor: number;
  invocation?: InvocationState;
}

const adapters = new WeakMap<AgentSession, InstalledAdapter>();

function sameModel(left: Model<Api> | undefined, right: Model<Api>): boolean {
  return left?.provider === right.provider && left.id === right.id;
}

function terminalFailureRemains(session: AgentSession, failure: AssistantFailure): boolean {
  const messages = session.agent.state.messages;
  return messages[messages.length - 1] === failure;
}

async function switchModel(
  session: AgentSession,
  privateSession: PrivateAgentSession,
  candidate: RetryModelCandidate,
  reason: ModelTransition["reason"],
  signal?: AbortSignal,
): Promise<ModelTransition | undefined> {
  if (signal?.aborted) return undefined;
  const liveModel = session.modelRuntime.getModel(candidate.model.provider, candidate.model.id);
  if (!liveModel) return undefined;
  const auth = await session.modelRuntime.checkAuth(liveModel.provider);
  if (!auth || signal?.aborted) return undefined;

  const effectiveCandidate = { ...candidate, model: liveModel };
  const previous = session.model;
  session.agent.state.model = liveModel;
  if (!sameModel(previous, liveModel)) {
    session.sessionManager.appendModelChange(liveModel.provider, liveModel.id);
  }

  const requested = candidate.thinking ?? session.thinkingLevel;
  const thinking = clampThinkingLevel(liveModel, requested);
  if (session.agent.state.thinkingLevel !== thinking) {
    session.agent.state.thinkingLevel = thinking;
    session.sessionManager.appendThinkingLevelChange(thinking);
    privateSession._emit({ type: "thinking_level_changed", level: thinking });
  }
  await privateSession._emitModelSelect(liveModel, previous, "set");
  return { candidate: effectiveCandidate, previous, thinking, reason };
}

async function advanceCandidate(
  session: AgentSession,
  adapter: InstalledAdapter,
): Promise<boolean> {
  const invocation = adapter.invocation;
  if (!invocation || invocation.signal?.aborted || invocation.canFallback?.() === false) return false;

  while (invocation.transitionsRemaining > 0) {
    invocation.transitionsRemaining--;
    invocation.cursor = (invocation.cursor + 1) % invocation.candidates.length;
    const candidate = invocation.candidates[invocation.cursor];
    const transition = await switchModel(
      session,
      adapter.privateSession,
      candidate,
      "fallback",
      invocation.signal,
    );
    if (!transition) continue;
    adapter.candidates = invocation.candidates;
    adapter.cursor = invocation.cursor;
    invocation.onTransition?.({
      ...transition,
      selection: invocation.candidates.map(item => item.input),
    });
    return true;
  }
  return false;
}

function installAdapter(session: AgentSession): InstalledAdapter {
  const existing = adapters.get(session);
  if (existing) return existing;

  const privateSession = session as unknown as PrivateAgentSession;
  if (
    typeof privateSession._handlePostAgentRun !== "function"
    || typeof privateSession._isRetryableError !== "function"
    || typeof privateSession._omitRecoveryAttempt !== "function"
    || typeof privateSession._emitModelSelect !== "function"
  ) {
    throw new Error("Model fallback is incompatible with this pi AgentSession implementation.");
  }

  const original = privateSession._handlePostAgentRun.bind(privateSession);
  const adapter: InstalledAdapter = {
    privateSession,
    original,
    candidates: [],
    cursor: 0,
  };
  privateSession._handlePostAgentRun = async () => {
    const failure = privateSession._lastAssistantMessage;
    const retryable = failure !== undefined && privateSession._isRetryableError(failure);
    const shouldContinue = await original();
    if (
      !retryable
      || failure === undefined
      || !terminalFailureRemains(session, failure)
      || adapter.invocation?.signal?.aborted
      || adapter.invocation?.canFallback?.() === false
    ) {
      return shouldContinue;
    }
    if (!(await advanceCandidate(session, adapter))) return shouldContinue;

    // Pi 0.87 made the SessionManager canonical for provider context: the failed
    // attempt must be omitted through the session projection, not by mutating
    // `agent.state.messages`. Reuse Pi's own recovery omission so the raw
    // transcript, accounting, and UI history stay intact.
    if (terminalFailureRemains(session, failure)) {
      privateSession._omitRecoveryAttempt(failure);
    }
    return true;
  };
  adapters.set(session, adapter);
  return adapter;
}

export interface ModelFallbackInvocation {
  candidates: RetryModelCandidate[];
  currentIndex?: number;
  maxWraparounds: number;
  signal?: AbortSignal;
  canFallback?: () => boolean;
  onTransition?: (transition: ModelTransition) => void;
}

/** Begin one outer run. The returned cleanup retains the live session cursor for resume. */
export function beginModelFallbackInvocation(
  session: AgentSession,
  options: ModelFallbackInvocation,
): () => void {
  if (options.candidates.length === 0) throw new Error("Model fallback requires at least one candidate.");
  if (options.candidates.length === 1 && options.maxWraparounds === 0) return () => {};
  const adapter = installAdapter(session);
  const currentIndex = options.currentIndex
    ?? options.candidates.findIndex(candidate => sameModel(session.model, candidate.model));
  const cursor = currentIndex >= 0 ? currentIndex : 0;
  const visits = options.candidates.length - cursor + options.maxWraparounds * options.candidates.length;
  adapter.candidates = options.candidates;
  adapter.cursor = cursor;
  adapter.invocation = {
    candidates: options.candidates,
    cursor,
    transitionsRemaining: Math.max(0, visits - 1),
    signal: options.signal,
    canFallback: options.canFallback,
    onTransition: options.onTransition,
  };
  return () => {
    const invocation = adapter.invocation;
    if (invocation) {
      adapter.candidates = invocation.candidates;
      adapter.cursor = invocation.cursor;
    }
    adapter.invocation = undefined;
  };
}

/** Record creation-time overrides that Pi applies without appending on reopen. */
export function recordReopenedModelSelection(
  session: AgentSession,
  candidate: RetryModelCandidate,
): void {
  const entries = session.sessionManager.getBranch();
  let recordedModel: string | undefined;
  let recordedThinking: string | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (recordedModel === undefined && entry.type === "model_change") {
      recordedModel = `${entry.provider}/${entry.modelId}`;
    }
    if (recordedThinking === undefined && entry.type === "thinking_level_change") {
      recordedThinking = entry.thinkingLevel;
    }
    if (recordedModel !== undefined && recordedThinking !== undefined) break;
  }
  const effectiveModel = `${candidate.model.provider}/${candidate.model.id}`;
  if (recordedModel !== effectiveModel) {
    session.sessionManager.appendModelChange(candidate.model.provider, candidate.model.id);
  }
  if (recordedThinking !== session.thinkingLevel) {
    session.sessionManager.appendThinkingLevelChange(session.thinkingLevel);
  }
}

/** Current live selection retained across invocations for in-memory resume. */
export function getSessionModelCandidates(
  session: AgentSession,
): { candidates: RetryModelCandidate[]; currentIndex: number } | undefined {
  const adapter = adapters.get(session);
  if (!adapter || adapter.candidates.length === 0) return undefined;
  return { candidates: adapter.candidates, currentIndex: adapter.cursor };
}

/** Replace a live session's selection, used by explicit resume overrides. */
export async function replaceSessionModelCandidates(
  session: AgentSession,
  candidates: RetryModelCandidate[],
  signal?: AbortSignal,
  onTransition?: (transition: ModelTransition) => void,
): Promise<void> {
  const adapter = installAdapter(session);
  const transition = await switchModel(session, adapter.privateSession, candidates[0], "override", signal);
  if (!transition) throw new Error(`Model unavailable: "${candidates[0].input}".`);
  adapter.candidates = candidates;
  adapter.cursor = 0;
  onTransition?.({ ...transition, selection: candidates.map(candidate => candidate.input) });
}
