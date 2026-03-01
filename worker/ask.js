import { checkRateLimit } from "./rateLimiter.js";
import { generateSQLWithRetry, isSentinel, parseSentinel, generateResponse, generateResponseStreaming } from "./llm.js";
import { QuestionInputSchema } from "./validation.js";
import { validateSQL } from "./sqlValidator.js";
import { SYSTEM_PROMPT, buildUserPrompt, injectDates, RESPONSE_SYSTEM_PROMPT, buildResponsePrompt } from "./prompts.js";

// Cache TTL in seconds (1 hour)
const CACHE_TTL = 3600;

/**
 * Get date context for cache key generation.
 */
function getDateContext() {
    const today = new Date();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());

    return {
        today: today.toISOString().split("T")[0],
        weekStart: weekStart.toISOString().split("T")[0],
    };
}

/**
 * Normalize a question for cache key generation.
 */
function normalizeQuestion(question) {
    return question
        .toLowerCase()
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[?!.,]+$/g, "");
}

/**
 * Generate a cache key for a question using SHA-256 hash.
 */
async function generateCacheKey(question, dateContext) {
    const normalizedQuestion = normalizeQuestion(question);
    const keyData = JSON.stringify({
        q: normalizedQuestion,
        today: dateContext.today,
        weekStart: dateContext.weekStart,
    });

    const encoder = new TextEncoder();
    const data = encoder.encode(keyData);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    return `ask:v2:${hashHex.substring(0, 32)}`;
}

/**
 * Try to get a cached response for a question.
 */
async function getCachedResponse(question, dateContext, env) {
    if (!env.ASK_CACHE_KV) {
        return null;
    }

    try {
        const cacheKey = await generateCacheKey(question, dateContext);
        const cached = await env.ASK_CACHE_KV.get(cacheKey, { type: "json" });
        if (cached) {
            console.log("Cache hit for question:", question);
            return cached;
        }
    } catch (error) {
        console.error("Cache read error:", error);
    }
    return null;
}

/**
 * Store a successful response in cache.
 */
async function cacheResponse(question, dateContext, responseData, env) {
    if (!env.ASK_CACHE_KV) {
        return;
    }

    try {
        const cacheKey = await generateCacheKey(question, dateContext);
        await env.ASK_CACHE_KV.put(cacheKey, JSON.stringify(responseData), {
            expirationTtl: CACHE_TTL,
        });
        console.log("Cached response for question:", question);
    } catch (error) {
        console.error("Cache write error:", error);
    }
}

/**
 * Validate and execute SQL against D1.
 * Used as the callback for generateSQLWithRetry.
 */
function createSQLExecutor(env) {
    return async function validateAndExecute(sql) {
        const { valid, error, sanitisedSql } = validateSQL(sql);
        if (!valid) {
            throw new Error(`SQL validation failed: ${error}`);
        }

        console.log("Executing SQL:", sanitisedSql);
        const response = await env.DB.prepare(sanitisedSql).all();
        return response.results || [];
    };
}

/**
 * Handle the /ask endpoint for natural language weather questions.
 */
export async function handleAskRequest(request, env) {
    // 1. Check rate limit
    const rateLimit = await checkRateLimit(request, env);
    if (!rateLimit.allowed) {
        return {
            result: {
                success: false,
                error: "rate_limit_exceeded",
                message: "You've reached your daily question limit. Please try again tomorrow.",
            },
            status: 429,
        };
    }

    // 2. Parse and validate input
    let body;
    try {
        body = await request.json();
    } catch {
        return {
            result: {
                success: false,
                error: "invalid_request",
                message: "Invalid JSON body",
            },
            status: 400,
        };
    }

    const inputValidation = QuestionInputSchema.safeParse(body);
    if (!inputValidation.success) {
        return {
            result: {
                success: false,
                error: "invalid_question",
                message: inputValidation.error.errors[0].message,
            },
            status: 400,
        };
    }

    const { question } = inputValidation.data;

    // 3. Check cache
    const dateContext = getDateContext();
    const cached = await getCachedResponse(question, dateContext, env);
    if (cached) {
        return {
            result: { ...cached, cached: true },
            status: 200,
        };
    }

    // 4. Generate SQL, validate, and execute
    const systemPrompt = injectDates(SYSTEM_PROMPT);
    let sql, results;

    try {
        ({ sql, results } = await generateSQLWithRetry(
            systemPrompt,
            buildUserPrompt(question),
            env,
            createSQLExecutor(env),
        ));
    } catch (error) {
        console.error("SQL generation/execution error:", error);
        return {
            result: {
                success: false,
                error: mapErrorType(error),
                message: mapErrorMessage(error),
            },
            status: mapErrorStatus(error),
        };
    }

    // 5. Handle sentinel responses (UNANSWERABLE / REJECTED)
    if (results === null && isSentinel(sql)) {
        const { type, reason } = parseSentinel(sql);
        if (type === "rejected") {
            return {
                result: {
                    success: false,
                    error: "rejected",
                    message: "Sorry, I can't process that request.",
                },
                status: 400,
            };
        }
        return {
            result: {
                success: false,
                error: "unanswerable",
                message: `I can only answer questions about Isle of Man weather forecasts. ${reason}`.trim(),
            },
            status: 400,
        };
    }

    // 6. Generate natural language answer
    let answer;
    try {
        const responseSystemPrompt = injectDates(RESPONSE_SYSTEM_PROMPT);
        const responseUserPrompt = buildResponsePrompt(question, results);
        answer = await generateResponse(responseSystemPrompt, responseUserPrompt, env);
    } catch (error) {
        console.error("Response generation error:", error);
        return {
            result: {
                success: false,
                error: "llm_error",
                message: "Failed to generate response. Please try again.",
            },
            status: 502,
        };
    }

    // 7. Build citations and cache
    const citations = buildCitations(results);

    const responseData = {
        success: true,
        answer,
        citations,
    };
    await cacheResponse(question, dateContext, responseData, env);

    return {
        result: { ...responseData, cached: false },
        status: 200,
    };
}

/**
 * Format an SSE event message.
 */
function formatSSE(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Get SSE response headers with CORS.
 */
function sseHeaders(origin) {
    return {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
    };
}

/**
 * Handle the /ask endpoint with Server-Sent Events for streaming responses.
 */
export async function handleAskStreamRequest(request, env) {
    const origin = request.headers.get("Origin");

    // 1. Check rate limit
    const rateLimit = await checkRateLimit(request, env);
    if (!rateLimit.allowed) {
        return new Response(
            formatSSE("error", {
                error: "rate_limit_exceeded",
                message: "You've reached your daily question limit. Please try again tomorrow.",
            }),
            { status: 429, headers: sseHeaders(origin) }
        );
    }

    // 2. Parse and validate input
    let body;
    try {
        body = await request.json();
    } catch {
        return new Response(
            formatSSE("error", {
                error: "invalid_request",
                message: "Invalid JSON body",
            }),
            { status: 400, headers: sseHeaders(origin) }
        );
    }

    const inputValidation = QuestionInputSchema.safeParse(body);
    if (!inputValidation.success) {
        return new Response(
            formatSSE("error", {
                error: "invalid_question",
                message: inputValidation.error.errors[0].message,
            }),
            { status: 400, headers: sseHeaders(origin) }
        );
    }

    const { question } = inputValidation.data;

    // 3. Check cache
    const dateContext = getDateContext();
    const cached = await getCachedResponse(question, dateContext, env);
    if (cached) {
        return new Response(formatSSE("complete", { ...cached, cached: true }), {
            status: 200,
            headers: sseHeaders(origin),
        });
    }

    // 4. Create streaming response
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
        try {
            // Phase 1: SQL generation and execution
            await writer.write(encoder.encode(formatSSE("status", { phase: "parsing", message: "Understanding your question..." })));

            const systemPrompt = injectDates(SYSTEM_PROMPT);
            let sql, results;

            try {
                ({ sql, results } = await generateSQLWithRetry(
                    systemPrompt,
                    buildUserPrompt(question),
                    env,
                    createSQLExecutor(env),
                ));
            } catch (error) {
                console.error("SQL generation/execution error:", error);
                await writer.write(
                    encoder.encode(
                        formatSSE("error", {
                            error: mapErrorType(error),
                            message: mapErrorMessage(error),
                        })
                    )
                );
                await writer.close();
                return;
            }

            // Handle sentinel responses
            if (results === null && isSentinel(sql)) {
                const { type, reason } = parseSentinel(sql);
                if (type === "rejected") {
                    await writer.write(
                        encoder.encode(
                            formatSSE("error", {
                                error: "rejected",
                                message: "Sorry, I can't process that request.",
                            })
                        )
                    );
                } else {
                    await writer.write(
                        encoder.encode(
                            formatSSE("error", {
                                error: "unanswerable",
                                message: `I can only answer questions about Isle of Man weather forecasts. ${reason}`.trim(),
                            })
                        )
                    );
                }
                await writer.close();
                return;
            }

            // Phase 2: Response generation (streamed)
            await writer.write(encoder.encode(formatSSE("status", { phase: "generating", message: "Composing answer..." })));

            let answer = "";
            try {
                const responseSystemPrompt = injectDates(RESPONSE_SYSTEM_PROMPT);
                const responseUserPrompt = buildResponsePrompt(question, results);

                answer = await generateResponseStreaming(responseSystemPrompt, responseUserPrompt, env, async (chunk) => {
                    await writer.write(encoder.encode(formatSSE("chunk", { text: chunk })));
                });
            } catch (error) {
                console.error("Response generation error:", error);
                await writer.write(
                    encoder.encode(
                        formatSSE("error", {
                            error: "llm_error",
                            message: "Failed to generate response. Please try again.",
                        })
                    )
                );
                await writer.close();
                return;
            }

            // Build citations and cache
            const citations = buildCitations(results);

            const responseData = {
                success: true,
                answer,
                citations,
            };
            await cacheResponse(question, dateContext, responseData, env);

            await writer.write(
                encoder.encode(
                    formatSSE("complete", {
                        success: true,
                        citations,
                        cached: false,
                    })
                )
            );
        } catch (error) {
            console.error("Streaming error:", error);
            await writer.write(
                encoder.encode(
                    formatSSE("error", {
                        error: "internal_error",
                        message: "An unexpected error occurred. Please try again.",
                    })
                )
            );
        } finally {
            await writer.close();
        }
    })();

    return new Response(readable, { status: 200, headers: sseHeaders(origin) });
}

/**
 * Build citations from query results.
 * Extracts forecast_date, published_at, description, and temps where available.
 */
function buildCitations(results) {
    if (!results || results.length === 0) {
        return [];
    }

    // Only build citations for rows that have forecast data
    return results
        .filter((r) => r.forecast_date && r.published_at)
        .map((r) => {
            const citation = {
                forecast_date: r.forecast_date,
                published_at: r.published_at,
                description: r.description,
            };
            if (r.min_temp != null && r.max_temp != null) {
                citation.min_temp = r.min_temp;
                citation.max_temp = r.max_temp;
            }
            return citation;
        });
}

function mapErrorType(error) {
    if (error.isTimeout) return "llm_timeout";
    if (error.isRateLimit) return "service_busy";
    if (error.isAuthError) return "llm_error";
    if (error.message?.includes("SQL validation")) return "internal_error";
    return "llm_error";
}

function mapErrorMessage(error) {
    if (error.isTimeout) return "Request timed out. Please try again.";
    if (error.isRateLimit) return "Service is temporarily busy. Please try again later.";
    if (error.isAuthError) return "Service configuration error. Please try again later.";
    return "Failed to process question. Please try again.";
}

function mapErrorStatus(error) {
    if (error.isTimeout) return 504;
    if (error.isRateLimit) return 503;
    if (error.isAuthError) return 502;
    return 502;
}
