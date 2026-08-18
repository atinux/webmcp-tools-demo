/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject, combineLatest, map, Observable } from 'rxjs';
import { GoogleGenAI } from '@google/genai';
import type { MLCEngineInterface, ChatCompletionMessageParam } from '@mlc-ai/web-llm';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'agent' | 'system';
  text: string;
  timestamp: Date;
  isExecuting?: boolean;
}

export type AiProvider = 'gemini' | 'local';

// Small enough to download once (~1 GB, cached by the browser) yet reliable at
// Hermes-style tool calling, which Qwen3 models are natively trained for.
export const LOCAL_MODEL_ID = 'Qwen3-1.7B-q4f16_1-MLC';

const MAX_LOCAL_TOOL_ROUNDS = 6;

interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

@Injectable({
  providedIn: 'root'
})
export class AgentService {
  private isOpenSubject = new BehaviorSubject<boolean>(false);
  isOpen$ = this.isOpenSubject.asObservable();

  private apiKeySubject = new BehaviorSubject<string>(localStorage.getItem('gemini_api_key') || '');
  apiKey$ = this.apiKeySubject.asObservable();

  private providerSubject = new BehaviorSubject<AiProvider>(this.readStoredProvider());
  provider$ = this.providerSubject.asObservable();

  /** True when the assistant can chat: local provider selected, or a Gemini key saved. */
  isConfigured$: Observable<boolean> = combineLatest([this.provider$, this.apiKey$]).pipe(
    map(([provider, key]) => provider === 'local' || !!key)
  );

  private messagesSubject = new BehaviorSubject<ChatMessage[]>([]);
  messages$ = this.messagesSubject.asObservable();

  private isLoadingSubject = new BehaviorSubject<boolean>(false);
  isLoading$ = this.isLoadingSubject.asObservable();

  private aiSession: GoogleGenAI | null = null;
  private chatSession: any = null;

  private localEngine: MLCEngineInterface | null = null;
  private localEnginePromise: Promise<MLCEngineInterface> | null = null;
  private localHistory: ChatCompletionMessageParam[] = [];

  constructor() {
    if (this.isConfigured) {
      this.initWelcomeMessage();
    }
  }

  private get isConfigured(): boolean {
    return this.providerSubject.value === 'local' || !!this.apiKeySubject.value;
  }

  private readStoredProvider(): AiProvider {
    const stored = localStorage.getItem('ai_provider');
    return stored === 'local' ? 'local' : 'gemini';
  }

  toggleOpen() {
    this.isOpenSubject.next(!this.isOpenSubject.value);
  }

  open() {
    this.isOpenSubject.next(true);
  }

  close() {
    this.isOpenSubject.next(false);
  }

  setProvider(provider: AiProvider) {
    if (provider === this.providerSubject.value) return;
    localStorage.setItem('ai_provider', provider);
    this.providerSubject.next(provider);
    this.resetChat();
  }

  setApiKey(key: string) {
    const trimmed = key.trim();
    if (!trimmed) return;
    localStorage.setItem('gemini_api_key', trimmed);
    localStorage.setItem('ai_provider', 'gemini');
    this.apiKeySubject.next(trimmed);
    this.providerSubject.next('gemini');
    this.resetChat();
  }

  logout() {
    localStorage.removeItem('gemini_api_key');
    this.apiKeySubject.next('');
    this.resetChat();
  }

  clearChat() {
    this.resetChat();
  }

  private resetChat() {
    this.aiSession = null;
    this.chatSession = null;
    // The local engine stays loaded (re-downloading the model is expensive);
    // only the conversation history is discarded.
    this.localHistory = [];
    this.messagesSubject.next([]);
    if (this.isConfigured) {
      this.initWelcomeMessage();
    }
  }

  private initWelcomeMessage() {
    const engineLabel = this.providerSubject.value === 'local'
      ? 'a local Qwen3 model running entirely in your browser'
      : 'Gemini 3.1 Flash Lite';
    const welcomeMsg: ChatMessage = {
      id: this.generateId(),
      sender: 'agent',
      text: `👋 Welcome to WebMCP Sports! I am your AI assistant powered by ${engineLabel} and WebMCP tools. How can I help you find gear, refine searches, check promos, or manage your cart today?`,
      timestamp: new Date()
    };
    this.messagesSubject.next([welcomeMsg]);
  }

  private async getTools(): Promise<WebMCP.RegisteredTool[]> {
    if (!document.modelContext) {
      return [];
    }
    try {
      return await document.modelContext.getTools();
    } catch (e) {
      console.error('Error fetching WebMCP tools:', e);
      return [];
    }
  }

  private parseToolSchema(tool: WebMCP.RegisteredTool): any {
    let schema: any = { type: 'object', properties: {} };
    if (tool.inputSchema) {
      try {
        schema = JSON.parse(tool.inputSchema);
      } catch (e) {
        console.error('Error parsing tool inputSchema:', e);
      }
    }
    return schema;
  }

  /** Executes a WebMCP tool with chat status feedback. Shared by both providers. */
  private async runTool(name: string, args: unknown): Promise<{ result?: unknown; error?: string }> {
    const sysMsgId = this.addMessage('system', `⚙️ Executing tool: ${name}...`, true);
    try {
      const tools = await this.getTools();
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Tool ${name} not found`);

      const rawResult = await (document.modelContext as any).executeTool(
        tool,
        JSON.stringify(args ?? {})
      );
      this.updateMessage(sysMsgId, `✅ Executed tool: ${name}`, false);
      return { result: rawResult };
    } catch (toolErr: any) {
      const errMsg = toolErr?.message || String(toolErr);
      this.updateMessage(sysMsgId, `❌ Tool ${name} error: ${errMsg}`, false);
      return { error: errMsg };
    }
  }

  private baseSystemInstruction(): string {
    return [
      'You are an intelligent AI assistant for "WebMCP Sports", a sports equipment e-commerce store.',
      'Help users find products, search items, apply price filters, inspect product details, view store promotions, add/remove items from cart, and check out.',
      'CRITICAL RULE: Use available WebMCP tools whenever appropriate to perform actions or fetch live page data. Do not make up product catalog information or fake tool calls.',
    ].join(' ');
  }

  async sendMessage(text: string) {
    const modelContext = document.modelContext;
    if (!modelContext) throw new Error('WebMCP is not supported in this browser environment');

    if (!this.isConfigured) {
      this.addMessage('system', '⚠️ No AI provider configured. Pick Local AI or enter a Gemini API key to proceed.');
      return;
    }

    const trimmed = text.trim();
    if (!trimmed || this.isLoadingSubject.value) return;

    this.addMessage('user', trimmed);
    this.isLoadingSubject.next(true);

    try {
      if (this.providerSubject.value === 'local') {
        await this.sendMessageLocal(trimmed);
      } else {
        await this.sendMessageGemini(trimmed);
      }
    } catch (err: any) {
      console.error('Agent error:', err);
      const errMsg = err?.message || String(err);
      this.addMessage('system', `❌ Error: ${errMsg}`);
    } finally {
      this.isLoadingSubject.next(false);
    }
  }

  // --------------------------------------------------------------------------
  // Gemini (cloud) provider
  // --------------------------------------------------------------------------

  private async getGeminiConfig() {
    const tools = await this.getTools();
    const functionDeclarations = tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      parametersJsonSchema: this.parseToolSchema(tool)
    }));

    return { systemInstruction: this.baseSystemInstruction(), tools: [{ functionDeclarations }] };
  }

  private async sendMessageGemini(trimmed: string) {
    if (!this.aiSession) {
      this.aiSession = new GoogleGenAI({ apiKey: this.apiKeySubject.value });
    }
    if (!this.chatSession) {
      this.chatSession = this.aiSession.chats.create({ model: 'gemini-3.1-flash-lite' });
    }

    let config = await this.getGeminiConfig();
    let currentResult = await this.chatSession.sendMessage({
      message: trimmed,
      config
    });

    let finalResponseGiven = false;

    while (!finalResponseGiven) {
      const response = currentResult;
      const functionCalls = response.functionCalls || [];

      if (functionCalls.length === 0) {
        if (response.text) {
          this.addMessage('agent', response.text);
        }
        finalResponseGiven = true;
      } else {
        const toolResponses = [];
        for (const call of functionCalls) {
          const { name, args } = call;
          const outcome = await this.runTool(name, args);
          toolResponses.push({
            functionResponse: {
              name,
              response: outcome.error ? { error: outcome.error } : { result: outcome.result }
            }
          });
        }

        config = await this.getGeminiConfig();
        currentResult = await this.chatSession.sendMessage({
          message: toolResponses,
          config
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Local (in-browser) provider — WebLLM running Qwen3 over WebGPU.
  // Tool calling uses Qwen3's native Hermes-style <tool_call> format so it
  // works without server-side templates or API keys.
  // --------------------------------------------------------------------------

  private async ensureLocalEngine(): Promise<MLCEngineInterface> {
    if (this.localEngine) return this.localEngine;
    if (!this.localEnginePromise) {
      this.localEnginePromise = this.loadLocalEngine();
      this.localEnginePromise.catch(() => {
        this.localEnginePromise = null;
      });
    }
    return this.localEnginePromise;
  }

  private async loadLocalEngine(): Promise<MLCEngineInterface> {
    if (!('gpu' in navigator)) {
      throw new Error('WebGPU is not available in this browser. The local AI model requires a WebGPU-enabled browser such as Chrome or Edge.');
    }

    const progressId = this.addMessage('system', `⏳ Preparing local model ${LOCAL_MODEL_ID}...`, true);
    try {
      // Loaded on demand so the WebLLM runtime never weighs on the initial bundle.
      const webllm = await import('@mlc-ai/web-llm');
      const engine = await webllm.CreateMLCEngine(LOCAL_MODEL_ID, {
        initProgressCallback: (report) => {
          this.updateMessage(progressId, `⏳ ${report.text}`, true);
        }
      });
      this.updateMessage(progressId, `✅ Local model ready: ${LOCAL_MODEL_ID}`, false);
      this.localEngine = engine;
      return engine;
    } catch (err: any) {
      this.updateMessage(progressId, `❌ Failed to load local model: ${err?.message || err}`, false);
      throw err;
    }
  }

  private async getLocalSystemPrompt(): Promise<string> {
    const tools = await this.getTools();
    const toolSignatures = tools
      .map((tool) => JSON.stringify({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: this.parseToolSchema(tool)
        }
      }))
      .join('\n');

    return [
      this.baseSystemInstruction(),
      '',
      '# Tools',
      'You may call one or more functions to assist with the user query.',
      'You are provided with function signatures within <tools></tools> XML tags:',
      '<tools>',
      toolSignatures,
      '</tools>',
      '',
      'For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:',
      '<tool_call>',
      '{"name": <function-name>, "arguments": <args-json-object>}',
      '</tool_call>',
      'Only call functions listed inside <tools>. After you receive results inside <tool_response> tags, answer the user in plain language without inventing data.',
      '/no_think'
    ].join('\n');
  }

  private parseLocalToolCalls(content: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    const matches = content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g);
    for (const match of matches) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (!parsed || typeof parsed.name !== 'string') continue;
        let args = parsed.arguments ?? {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        calls.push({ name: parsed.name, arguments: args });
      } catch (e) {
        console.error('Error parsing local tool call:', e, match[1]);
      }
    }
    return calls;
  }

  private stripLocalMarkup(content: string): string {
    return content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .trim();
  }

  private async sendMessageLocal(trimmed: string) {
    const engine = await this.ensureLocalEngine();

    this.localHistory.push({ role: 'user', content: trimmed });

    for (let round = 0; round < MAX_LOCAL_TOOL_ROUNDS; round++) {
      // The system prompt is rebuilt every round because WebMCP tools are
      // page-scoped: navigation triggered by a tool can register new tools.
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: await this.getLocalSystemPrompt() },
        ...this.localHistory
      ];

      const reply = await engine.chat.completions.create({
        messages,
        temperature: 0.2,
        max_tokens: 1024
      });

      const rawContent = reply.choices[0]?.message?.content ?? '';
      this.localHistory.push({ role: 'assistant', content: rawContent });

      const toolCalls = this.parseLocalToolCalls(rawContent);
      if (toolCalls.length === 0) {
        const text = this.stripLocalMarkup(rawContent);
        this.addMessage('agent', text || '🤔 The local model returned an empty response. Please try rephrasing.');
        return;
      }

      const toolResponses: string[] = [];
      for (const call of toolCalls) {
        const outcome = await this.runTool(call.name, call.arguments);
        toolResponses.push([
          '<tool_response>',
          JSON.stringify({
            name: call.name,
            ...(outcome.error ? { error: outcome.error } : { result: outcome.result })
          }),
          '</tool_response>'
        ].join('\n'));
      }
      this.localHistory.push({ role: 'user', content: toolResponses.join('\n') });
    }

    this.addMessage('system', '⚠️ Stopped after too many consecutive tool calls. Please refine your request.');
  }

  private addMessage(sender: 'user' | 'agent' | 'system', text: string, isExecuting = false): string {
    const id = this.generateId();
    const newMsg: ChatMessage = {
      id,
      sender,
      text,
      timestamp: new Date(),
      isExecuting
    };
    const current = this.messagesSubject.value;
    this.messagesSubject.next([...current, newMsg]);
    return id;
  }

  private updateMessage(id: string, text: string, isExecuting = false) {
    const current = this.messagesSubject.value;
    const updated = current.map((m) =>
      m.id === id ? { ...m, text, isExecuting } : m
    );
    this.messagesSubject.next(updated);
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 9);
  }
}
