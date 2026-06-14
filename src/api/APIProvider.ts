/**
 * API Provider definitions and request logic for API Key direct call (P2).
 *
 * Supports: Anthropic (Claude), OpenAI (GPT), DeepSeek, Google Gemini, Custom (OpenAI-compat).
 */

export type APIProviderType = "anthropic" | "openai" | "deepseek" | "gemini" | "custom";

export interface APIProviderConfig {
	provider: APIProviderType;
	apiKey: string;
	model: string;
	/** Only used when provider === "custom" */
	customEndpoint?: string;
	maxTokens: number;
}

export const PROVIDER_DEFAULTS: Record<APIProviderType, { model: string; endpoint: string }> = {
	anthropic: {
		model: "claude-opus-4-5",
		endpoint: "https://api.anthropic.com/v1/messages",
	},
	openai: {
		model: "gpt-4o",
		endpoint: "https://api.openai.com/v1/chat/completions",
	},
	deepseek: {
		model: "deepseek-v4-flash",
		endpoint: "https://api.deepseek.com/chat/completions",
	},
	gemini: {
		model: "gemini-1.5-pro",
		endpoint:
			"https://generativelanguage.googleapis.com/v1beta/models/{{model}}:generateContent",
	},
	custom: {
		model: "gpt-4o",
		endpoint: "",
	},
};

export interface APICallRequest {
	systemPrompt: string;
	userMessage: string;
}

export interface APICallResult {
	success: boolean;
	text?: string;
	error?: string;
}

// ---------- main API caller ----------

/**
 * Call the selected provider and return the model's text response.
 * Uses fetch() which is available in Obsidian's Electron context.
 */
export async function callAPI(
	config: APIProviderConfig,
	req: APICallRequest,
): Promise<APICallResult> {
	try {
		switch (config.provider) {
			case "anthropic":
				return await callAnthropic(config, req);
			case "openai":
			case "deepseek":
			case "custom":
				return await callOpenAICompat(config, req);
			case "gemini":
				return await callGemini(config, req);
		}
	} catch (err) {
		return { success: false, error: String(err) };
	}
}

// ---------- Anthropic ----------

async function callAnthropic(
	config: APIProviderConfig,
	req: APICallRequest,
): Promise<APICallResult> {
	const endpoint = PROVIDER_DEFAULTS.anthropic.endpoint;

	const body = JSON.stringify({
		model: config.model || PROVIDER_DEFAULTS.anthropic.model,
		max_tokens: config.maxTokens,
		system: req.systemPrompt,
		messages: [{ role: "user", content: req.userMessage }],
	});

	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": config.apiKey,
			"anthropic-version": "2023-06-01",
		},
		body,
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => res.statusText);
		return { success: false, error: `${res.status} ${errText}` };
	}

	const json = await res.json() as {
		content?: Array<{ type: string; text?: string }>;
		error?: { message?: string };
	};

	if (json.error) {
		return { success: false, error: json.error.message ?? "Anthropic error" };
	}

	const text = json.content?.find((c) => c.type === "text")?.text ?? "";
	return { success: true, text };
}

// ---------- OpenAI / Custom (OpenAI-compat) ----------

async function callOpenAICompat(
	config: APIProviderConfig,
	req: APICallRequest,
): Promise<APICallResult> {
	let endpoint: string;
	if (config.provider === "custom" && config.customEndpoint) {
		endpoint = config.customEndpoint;
	} else if (PROVIDER_DEFAULTS[config.provider]) {
		endpoint = PROVIDER_DEFAULTS[config.provider].endpoint;
	} else {
		endpoint = PROVIDER_DEFAULTS.openai.endpoint;
	}

	const body = JSON.stringify({
		model: config.model || PROVIDER_DEFAULTS[config.provider]?.model || PROVIDER_DEFAULTS.openai.model,
		max_tokens: config.maxTokens,
		messages: [
			{ role: "system", content: req.systemPrompt },
			{ role: "user", content: req.userMessage },
		],
	});

	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
		body,
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => res.statusText);
		return { success: false, error: `${res.status} ${errText}` };
	}

	const json = await res.json() as {
		choices?: Array<{ message?: { content?: string } }>;
		error?: { message?: string };
	};

	if (json.error) {
		return { success: false, error: json.error.message ?? "OpenAI error" };
	}

	const text = json.choices?.[0]?.message?.content ?? "";
	return { success: true, text };
}

// ---------- Gemini ----------

async function callGemini(
	config: APIProviderConfig,
	req: APICallRequest,
): Promise<APICallResult> {
	const model = config.model || PROVIDER_DEFAULTS.gemini.model;
	const endpoint = PROVIDER_DEFAULTS.gemini.endpoint.replace("{{model}}", model);
	const url = `${endpoint}?key=${encodeURIComponent(config.apiKey)}`;

	const body = JSON.stringify({
		system_instruction: { parts: [{ text: req.systemPrompt }] },
		contents: [{ role: "user", parts: [{ text: req.userMessage }] }],
		generationConfig: { maxOutputTokens: config.maxTokens },
	});

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => res.statusText);
		return { success: false, error: `${res.status} ${errText}` };
	}

	const json = await res.json() as {
		candidates?: Array<{
			content?: { parts?: Array<{ text?: string }> };
		}>;
		error?: { message?: string };
	};

	if (json.error) {
		return { success: false, error: json.error.message ?? "Gemini error" };
	}

	const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
	return { success: true, text };
}

// ---------- Prompt builder ----------

export const API_SYSTEM_PROMPT = `你是专业文档编辑助手。
请严格按照批阅意见修改文档，遵循以下规则：
1. 只修改有批阅意见覆盖的内容。
2. 删除线 (strike: true) 表示强删除/合并意图，结合上下文判断。
3. 输出完整修改后的 Markdown 文档，不添加任何额外说明文字。
4. 直接输出修改后的 Markdown，不要用代码块包裹。`;

export function buildAPIUserMessage(originalText: string, reviewMarkdown: string): string {
	return `## 原文\n\n${originalText}\n\n---\n\n${reviewMarkdown}`;
}
