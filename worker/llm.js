import { getLLMConfig } from "./config.js";

/**
 * Log LLM request and response for debugging.
 */
function logLLMInteraction(label, systemPrompt, userPrompt, response, error = null) {
    console.log(`\n===== LLM ${label} =====`);
    console.log(`[System Prompt] (${systemPrompt.length} chars):`);
    console.log(systemPrompt.length > 500 ? systemPrompt.substring(0, 500) + "..." : systemPrompt);
    console.log(`\n[User Prompt]:`);
    console.log(userPrompt);
    if (error) {
        console.log(`\n[Error]:`, error.message);
    } else if (response) {
        console.log(`\n[Response]:`);
        console.log(typeof response === "string" ? response : JSON.stringify(response, null, 2));
    }
    console.log(`===== END ${label} =====\n`);
}

/**
 * Core LLM request function.
 *
 * @param {string} systemPrompt - The system prompt with instructions
 * @param {string} userPrompt - The user's question/prompt
 * @param {Object} env - Environment bindings including LLM_API_KEY
 * @param {Object} options - Request options
 * @param {number} options.temperature - LLM temperature
 * @param {number} options.maxTokens - Maximum tokens in response
 * @returns {Promise<string>} - Text response
 * @throws {Error} - On timeout, API errors, or invalid responses
 */
async function makeLLMRequest(systemPrompt, userPrompt, env, options) {
    const { temperature, maxTokens } = options;
    const llmConfig = getLLMConfig(env);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), llmConfig.timeoutMs);

    try {
        const response = await fetch(llmConfig.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.LLM_API_KEY}`,
            },
            body: JSON.stringify({
                model: llmConfig.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                temperature,
                max_tokens: maxTokens,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 429) {
            const resetTime = response.headers.get("x-ratelimit-reset-requests");
            const error = new Error("Venice API rate limit exceeded");
            error.isRateLimit = true;
            error.resetTime = resetTime;
            console.error("Venice rate limit hit. Reset time:", resetTime);
            throw error;
        }

        if (response.status === 401 || response.status === 403) {
            const error = new Error(`Venice API authentication failed: ${response.status}`);
            error.isAuthError = true;
            console.error("Venice auth error:", response.status);
            throw error;
        }

        if (response.status >= 500) {
            const error = new Error(`Venice API server error: ${response.status}`);
            error.isServerError = true;
            throw error;
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Venice API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
            throw new Error("Empty response from Venice API");
        }

        return content.trim();
    } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === "AbortError") {
            const timeoutError = new Error("LLM request timeout");
            timeoutError.isTimeout = true;
            throw timeoutError;
        }

        throw error;
    }
}

/**
 * Execute an LLM request with retry logic for server errors.
 */
async function executeWithRetry(systemPrompt, userPrompt, env, options, logLabel) {
    const llmConfig = getLLMConfig(env);
    let lastError;

    for (let attempt = 0; attempt <= llmConfig.maxRetries; attempt++) {
        try {
            const result = await makeLLMRequest(systemPrompt, userPrompt, env, options);
            logLLMInteraction(logLabel, systemPrompt, userPrompt, result);
            return result;
        } catch (error) {
            lastError = error;
            logLLMInteraction(logLabel, systemPrompt, userPrompt, null, error);

            if (error.isRateLimit || error.isAuthError) {
                throw error;
            }

            if (attempt < llmConfig.maxRetries && error.isServerError) {
                console.log(`LLM request failed (attempt ${attempt + 1}), retrying...`);
                await sleep(1000);
                continue;
            }

            throw error;
        }
    }

    throw lastError;
}

/**
 * Generate SQL from a natural language question.
 * Uses low temperature for deterministic output.
 *
 * @param {string} systemPrompt - SQL generation system prompt
 * @param {string} question - The user's weather question
 * @param {Object} env - Environment bindings
 * @returns {Promise<string>} - Raw SQL string or sentinel (UNANSWERABLE:/REJECTED:)
 */
export async function generateSQL(systemPrompt, question, env) {
    const llmConfig = getLLMConfig(env);
    return executeWithRetry(systemPrompt, question, env, {
        temperature: llmConfig.temperature.structured,
        maxTokens: llmConfig.maxTokens.structured,
    }, "SQL GENERATION");
}

/**
 * Generate SQL with self-correction on failure.
 * If the first SQL fails validation or execution, feeds the error back
 * to the model for one retry attempt.
 *
 * @param {string} systemPrompt - SQL generation system prompt
 * @param {string} question - The user's weather question
 * @param {Object} env - Environment bindings
 * @param {Function} validateAndExecute - Callback: (sql) => { results } or throws
 * @returns {Promise<{ sql: string, results: Array }>}
 */
export async function generateSQLWithRetry(systemPrompt, question, env, validateAndExecute) {
    const sql = await generateSQL(systemPrompt, question, env);

    // Check for sentinel values before validation
    if (isSentinel(sql)) {
        return { sql, results: null };
    }

    // Strip markdown code fences if the model wraps SQL in them
    const cleanSql = stripCodeFences(sql);

    try {
        const results = await validateAndExecute(cleanSql);
        return { sql: cleanSql, results };
    } catch (firstError) {
        console.log("SQL self-correction: first attempt failed:", firstError.message);

        // Self-correction: feed the error back for one retry
        const retryPrompt = `${question}\n\nYour previous SQL returned an error: ${firstError.message}\nPlease generate a corrected query.`;
        const retrySql = await generateSQL(systemPrompt, retryPrompt, env);

        if (isSentinel(retrySql)) {
            return { sql: retrySql, results: null };
        }

        const cleanRetrySql = stripCodeFences(retrySql);
        const results = await validateAndExecute(cleanRetrySql);
        return { sql: cleanRetrySql, results };
    }
}

/**
 * Check if the LLM response is a sentinel value rather than SQL.
 */
export function isSentinel(response) {
    const upper = response.toUpperCase();
    return upper.startsWith("UNANSWERABLE:") || upper.startsWith("REJECTED:");
}

/**
 * Parse a sentinel response into { type, reason }.
 */
export function parseSentinel(response) {
    const colonIndex = response.indexOf(":");
    const type = response.substring(0, colonIndex).trim().toLowerCase();
    const reason = response.substring(colonIndex + 1).trim();
    return { type, reason };
}

/**
 * Strip markdown code fences from LLM output.
 */
function stripCodeFences(text) {
    const match = text.match(/^```(?:sql)?\s*\n?([\s\S]*?)```$/m);
    if (match) return match[1].trim();
    return text.trim();
}

/**
 * Generate a natural language response from query results.
 */
export async function generateResponse(systemPrompt, userPrompt, env) {
    const llmConfig = getLLMConfig(env);
    return executeWithRetry(systemPrompt, userPrompt, env, {
        temperature: llmConfig.temperature.natural,
        maxTokens: llmConfig.maxTokens.natural,
    }, "RESPONSE GEN");
}

/**
 * Generate a streaming natural language response from the LLM.
 */
export async function generateResponseStreaming(systemPrompt, userPrompt, env, onChunk) {
    const llmConfig = getLLMConfig(env);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), llmConfig.timeoutMs);

    console.log("\n===== LLM STREAMING RESPONSE GEN =====");
    console.log(`[System Prompt] (${systemPrompt.length} chars)`);
    console.log(`[User Prompt]: ${userPrompt.substring(0, 200)}...`);

    try {
        const response = await fetch(llmConfig.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.LLM_API_KEY}`,
            },
            body: JSON.stringify({
                model: llmConfig.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                temperature: llmConfig.temperature.natural,
                max_tokens: llmConfig.maxTokens.natural,
                stream: true,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 429) {
            const error = new Error("Venice API rate limit exceeded");
            error.isRateLimit = true;
            throw error;
        }

        if (response.status === 401 || response.status === 403) {
            const error = new Error(`Venice API authentication failed: ${response.status}`);
            error.isAuthError = true;
            throw error;
        }

        if (response.status >= 500) {
            const error = new Error(`Venice API server error: ${response.status}`);
            error.isServerError = true;
            throw error;
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Venice API error: ${response.status} - ${errorText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const data = line.slice(6).trim();
                    if (data === "[DONE]") continue;

                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            fullContent += content;
                            await onChunk(content);
                        }
                    } catch {
                        // Skip malformed chunks
                    }
                }
            }
        }

        console.log(`[Streaming Response] (${fullContent.length} chars): ${fullContent.substring(0, 100)}...`);
        console.log("===== END STREAMING RESPONSE GEN =====\n");

        return fullContent;
    } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === "AbortError") {
            const timeoutError = new Error("LLM streaming request timeout");
            timeoutError.isTimeout = true;
            throw timeoutError;
        }

        console.error("Streaming error:", error.message);
        console.log("===== END STREAMING RESPONSE GEN (ERROR) =====\n");
        throw error;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
