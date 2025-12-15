import { CONFIG, getLLMConfig } from "./config.js";

/**
 * Log LLM request and response for debugging.
 */
function logLLMInteraction(label, systemPrompt, userPrompt, response, error = null) {
    console.log(`\n===== LLM ${label} =====`);
    console.log(`[System Prompt] (${systemPrompt.length} chars):`);
    // Log first 500 chars of system prompt to avoid flooding logs
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
 * Core LLM request function that handles both structured and natural language responses.
 * Consolidates the common logic for API calls, error handling, and response processing.
 *
 * @param {string} systemPrompt - The system prompt with instructions
 * @param {string} userPrompt - The user's question/prompt
 * @param {Object} env - Environment bindings including LLM_API_KEY
 * @param {Object} options - Request options
 * @param {number} options.temperature - LLM temperature (0.1 for structured, 0.7 for natural)
 * @param {number} options.maxTokens - Maximum tokens in response
 * @param {boolean} options.parseAsJson - Whether to parse response as JSON
 * @returns {Promise<Object|string>} - Parsed JSON object or text response
 * @throws {Error} - On timeout, API errors, or invalid responses
 */
async function makeLLMRequest(systemPrompt, userPrompt, env, options) {
    const { temperature, maxTokens, parseAsJson } = options;
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

        // Handle rate limit (Venice API cap hit)
        if (response.status === 429) {
            const resetTime = response.headers.get("x-ratelimit-reset-requests");
            const error = new Error("Venice API rate limit exceeded");
            error.isRateLimit = true;
            error.resetTime = resetTime;
            console.error("Venice rate limit hit. Reset time:", resetTime);
            throw error;
        }

        // Handle auth errors
        if (response.status === 401 || response.status === 403) {
            const error = new Error(`Venice API authentication failed: ${response.status}`);
            error.isAuthError = true;
            console.error("Venice auth error:", response.status);
            throw error;
        }

        // Handle server errors (may retry)
        if (response.status >= 500) {
            const error = new Error(`Venice API server error: ${response.status}`);
            error.isServerError = true;
            throw error;
        }

        // Handle other non-OK responses
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Venice API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
            throw new Error("Empty response from Venice API");
        }

        // Return parsed JSON or trimmed text based on options
        return parseAsJson ? parseJSONResponse(content) : content.trim();
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
 *
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @param {Object} env - Environment bindings
 * @param {Object} options - Request options (temperature, maxTokens, parseAsJson)
 * @param {string} logLabel - Label for logging
 * @returns {Promise<Object|string>} - LLM response
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

            // Don't retry on rate limits or auth errors
            if (error.isRateLimit || error.isAuthError) {
                throw error;
            }

            // Retry on server errors
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
 * Query the LLM for structured JSON output.
 * Uses low temperature for consistent, deterministic responses.
 *
 * @param {string} systemPrompt - The system prompt with instructions
 * @param {string} userPrompt - The user's question formatted as a prompt
 * @param {Object} env - Environment bindings including LLM_API_KEY
 * @returns {Promise<Object>} - Parsed JSON response from LLM
 * @throws {Error} - On timeout, API errors, or invalid responses
 */
export async function queryLLM(systemPrompt, userPrompt, env) {
    const llmConfig = getLLMConfig(env);
    return executeWithRetry(systemPrompt, userPrompt, env, {
        temperature: llmConfig.temperature.structured,
        maxTokens: llmConfig.maxTokens.structured,
        parseAsJson: true,
    }, "QUERY PARSE");
}

/**
 * Query the LLM for a natural language text response.
 * Uses higher temperature for more varied, natural responses.
 *
 * @param {string} systemPrompt - The system prompt with instructions
 * @param {string} userPrompt - The user's question with data context
 * @param {Object} env - Environment bindings including LLM_API_KEY
 * @returns {Promise<string>} - Text response from LLM
 * @throws {Error} - On timeout, API errors, or invalid responses
 */
export async function generateResponse(systemPrompt, userPrompt, env) {
    const llmConfig = getLLMConfig(env);
    return executeWithRetry(systemPrompt, userPrompt, env, {
        temperature: llmConfig.temperature.natural,
        maxTokens: llmConfig.maxTokens.natural,
        parseAsJson: false,
    }, "RESPONSE GEN");
}

/**
 * Parse JSON from LLM response, handling markdown code blocks.
 * The LLM sometimes wraps JSON in ```json blocks or includes extra text.
 *
 * @param {string} content - Raw LLM response content
 * @returns {Object} - Parsed JSON object
 * @throws {Error} - If no valid JSON can be extracted
 */
function parseJSONResponse(content) {
    // Try direct JSON parse first
    try {
        return JSON.parse(content);
    } catch {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[1].trim());
            } catch {
                // Fall through to next attempt
            }
        }

        // Try to find JSON object in the content
        const objectMatch = content.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            try {
                return JSON.parse(objectMatch[0]);
            } catch {
                // Fall through to error
            }
        }

        throw new Error(`Invalid JSON in response: ${content.substring(0, 200)}`);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
