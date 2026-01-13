import { checkRateLimit } from "./rateLimiter.js";
import { queryLLM, generateResponse, generateResponseStreaming } from "./llm.js";
import { QueryIntentSchema, QuestionInputSchema, UnanswerableSchema, RejectedSchema } from "./validation.js";
import { buildQuery } from "./queryBuilder.js";
import { SYSTEM_PROMPT, buildUserPrompt, injectDates, RESPONSE_SYSTEM_PROMPT, buildResponsePrompt } from "./prompts.js";
import { formatRainfall, formatDateLong, formatDateShort, formatFieldName } from "./utils.js";

// Cache TTL in seconds (1 hour)
const CACHE_TTL = 3600;

/**
 * Get date context for cache key generation.
 * Includes today and week start to handle relative date queries.
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
 * Ensures equivalent questions map to the same cache key.
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
 * Key format: ask:v1:<32-char-hash>
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

    return `ask:v1:${hashHex.substring(0, 32)}`;
}

/**
 * Try to get a cached response for a question.
 * Returns null if cache miss or KV not available.
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
 * Handle the /ask endpoint for natural language weather questions.
 *
 * @param {Request} request - The incoming request
 * @param {Object} env - Environment bindings
 * @returns {Promise<{result: Object, status: number}>}
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

    // 3. Check cache before making LLM calls
    const dateContext = getDateContext();
    const cached = await getCachedResponse(question, dateContext, env);
    if (cached) {
        return {
            result: { ...cached, cached: true },
            status: 200,
        };
    }

    // 4. Query LLM for structured intent
    let llmResponse;
    try {
        const systemPrompt = injectDates(SYSTEM_PROMPT);
        const userPrompt = buildUserPrompt(question);
        llmResponse = await queryLLM(systemPrompt, userPrompt, env);
    } catch (error) {
        console.error("LLM error:", error);

        if (error.isTimeout) {
            return {
                result: {
                    success: false,
                    error: "llm_timeout",
                    message: "Request timed out. Please try again.",
                },
                status: 504,
            };
        }

        if (error.isRateLimit) {
            return {
                result: {
                    success: false,
                    error: "service_busy",
                    message: "Service is temporarily busy. Please try again later.",
                },
                status: 503,
            };
        }

        if (error.isAuthError) {
            console.error("LLM API auth failed - check LLM_API_KEY");
            return {
                result: {
                    success: false,
                    error: "llm_error",
                    message: "Service configuration error. Please try again later.",
                },
                status: 502,
            };
        }

        return {
            result: {
                success: false,
                error: "llm_error",
                message: "Failed to process question. Please try again.",
            },
            status: 502,
        };
    }

    // 4. Check for rejected response (security/injection attempts)
    const rejectedCheck = RejectedSchema.safeParse(llmResponse);
    if (rejectedCheck.success) {
        return {
            result: {
                success: false,
                error: "rejected",
                message: "Sorry, I can't process that request.",
            },
            status: 400,
        };
    }

    // 5. Check for unanswerable response (non-weather questions)
    const unanswerableCheck = UnanswerableSchema.safeParse(llmResponse);
    if (unanswerableCheck.success) {
        return {
            result: {
                success: false,
                error: "unanswerable",
                message: `I can only answer questions about Isle of Man weather forecasts. ${unanswerableCheck.data.reason || ""}`.trim(),
            },
            status: 400,
        };
    }

    // 6. Validate LLM response against schema
    const intentValidation = QueryIntentSchema.safeParse(llmResponse);
    if (!intentValidation.success) {
        console.error("Intent validation failed:", intentValidation.error.errors, "Response:", llmResponse);
        return {
            result: {
                success: false,
                error: "llm_invalid_response",
                message: "I couldn't understand that question. Please try rephrasing it.",
            },
            status: 500,
        };
    }

    const validatedIntent = intentValidation.data;

    // 7. Build and execute safe SQL query
    let results;
    try {
        const { sql, params } = buildQuery(validatedIntent);
        console.log("Executing query:", sql, "Params:", params);

        const stmt = env.DB.prepare(sql);
        const bound = params.length > 0 ? stmt.bind(...params) : stmt;
        const response = await bound.all();
        results = response.results || [];
    } catch (dbError) {
        console.error("Database error:", dbError);
        return {
            result: {
                success: false,
                error: "internal_error",
                message: "Database query failed. Please try again.",
            },
            status: 500,
        };
    }

    // 8. Generate natural language answer using LLM
    let answer;
    try {
        const responseSystemPrompt = injectDates(RESPONSE_SYSTEM_PROMPT);
        const responseUserPrompt = buildResponsePrompt(question, validatedIntent.query_type, results);
        answer = await generateResponse(responseSystemPrompt, responseUserPrompt, env);
    } catch (error) {
        console.error("Response generation error:", error);
        // Fall back to template-based response if LLM fails
        const fallback = generateFallbackAnswer(validatedIntent, results);
        return {
            result: { ...fallback, cached: false },
            status: 200,
        };
    }

    // Build citations from results
    const citations = buildCitations(validatedIntent, results);

    // Cache the successful response
    const responseData = {
        success: true,
        answer,
        citations,
        query_type: validatedIntent.query_type,
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
 * Map error types to user-friendly error codes.
 */
function getErrorType(error) {
    if (error.isTimeout) return "llm_timeout";
    if (error.isRateLimit) return "service_busy";
    if (error.isAuthError) return "llm_error";
    if (error.isServerError) return "llm_error";
    return "internal_error";
}

/**
 * Map error types to user-friendly messages.
 */
function getErrorMessage(error) {
    if (error.isTimeout) return "Request timed out. Please try again.";
    if (error.isRateLimit) return "Service is temporarily busy. Please try again later.";
    if (error.isAuthError) return "Service configuration error. Please try again later.";
    return "Failed to process question. Please try again.";
}

/**
 * Handle the /ask endpoint with Server-Sent Events for streaming responses.
 * Returns SSE stream with status updates, text chunks, and final result.
 *
 * @param {Request} request - The incoming request
 * @param {Object} env - Environment bindings
 * @returns {Response} - SSE streaming response
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

    // 3. Check cache - return instant response if cached
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

    // Start async processing
    (async () => {
        try {
            // Phase 1: Intent parsing (not streamed)
            await writer.write(encoder.encode(formatSSE("status", { phase: "parsing", message: "Understanding your question..." })));

            let llmResponse;
            try {
                const systemPrompt = injectDates(SYSTEM_PROMPT);
                const userPrompt = buildUserPrompt(question);
                llmResponse = await queryLLM(systemPrompt, userPrompt, env);
            } catch (error) {
                await writer.write(
                    encoder.encode(
                        formatSSE("error", {
                            error: getErrorType(error),
                            message: getErrorMessage(error),
                        })
                    )
                );
                await writer.close();
                return;
            }

            // Check for rejected response
            const rejectedCheck = RejectedSchema.safeParse(llmResponse);
            if (rejectedCheck.success) {
                await writer.write(
                    encoder.encode(
                        formatSSE("error", {
                            error: "rejected",
                            message: "Sorry, I can't process that request.",
                        })
                    )
                );
                await writer.close();
                return;
            }

            // Check for unanswerable response
            const unanswerableCheck = UnanswerableSchema.safeParse(llmResponse);
            if (unanswerableCheck.success) {
                await writer.write(
                    encoder.encode(
                        formatSSE("error", {
                            error: "unanswerable",
                            message: `I can only answer questions about Isle of Man weather forecasts. ${unanswerableCheck.data.reason || ""}`.trim(),
                        })
                    )
                );
                await writer.close();
                return;
            }

            // Validate intent
            const intentValidation = QueryIntentSchema.safeParse(llmResponse);
            if (!intentValidation.success) {
                await writer.write(
                    encoder.encode(
                        formatSSE("error", {
                            error: "llm_invalid_response",
                            message: "I couldn't understand that question. Please try rephrasing it.",
                        })
                    )
                );
                await writer.close();
                return;
            }

            const validatedIntent = intentValidation.data;

            // Phase 2: Database query
            await writer.write(encoder.encode(formatSSE("status", { phase: "querying", message: "Searching weather data..." })));

            let results;
            try {
                const { sql, params } = buildQuery(validatedIntent);
                const stmt = env.DB.prepare(sql);
                const bound = params.length > 0 ? stmt.bind(...params) : stmt;
                const response = await bound.all();
                results = response.results || [];
            } catch (dbError) {
                console.error("Database error:", dbError);
                await writer.write(
                    encoder.encode(
                        formatSSE("error", {
                            error: "internal_error",
                            message: "Database query failed. Please try again.",
                        })
                    )
                );
                await writer.close();
                return;
            }

            // Phase 3: Response generation (STREAMED)
            await writer.write(encoder.encode(formatSSE("status", { phase: "generating", message: "Composing answer..." })));

            let answer = "";
            try {
                const responseSystemPrompt = injectDates(RESPONSE_SYSTEM_PROMPT);
                const responseUserPrompt = buildResponsePrompt(question, validatedIntent.query_type, results);

                answer = await generateResponseStreaming(responseSystemPrompt, responseUserPrompt, env, async (chunk) => {
                    await writer.write(encoder.encode(formatSSE("chunk", { text: chunk })));
                });
            } catch (error) {
                console.error("Response generation error:", error);
                // Fall back to template-based response
                const fallback = generateFallbackAnswer(validatedIntent, results);
                answer = fallback.answer;
                // Send fallback as single chunk
                await writer.write(encoder.encode(formatSSE("chunk", { text: answer })));
            }

            // Build citations
            const citations = buildCitations(validatedIntent, results);

            // Cache the response
            const responseData = {
                success: true,
                answer,
                citations,
                query_type: validatedIntent.query_type,
            };
            await cacheResponse(question, dateContext, responseData, env);

            // Send complete event
            await writer.write(
                encoder.encode(
                    formatSSE("complete", {
                        success: true,
                        citations,
                        query_type: validatedIntent.query_type,
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
 * Build citations array from query results.
 */
function buildCitations(intent, results) {
    if (!results || results.length === 0) {
        return [];
    }

    // Aggregated queries don't have forecast citations
    if (intent.query_type === "average_over_range" || intent.query_type === "count_days_with" || intent.query_type === "max_streak") {
        return [];
    }

    // For compare_dates, list_days_with, period_summary - get the latest forecast for each date
    if (intent.query_type === "compare_dates" || intent.query_type === "list_days_with" || intent.query_type === "period_summary") {
        const byDate = {};
        for (const r of results) {
            if (!byDate[r.forecast_date] || new Date(r.published_at) > new Date(byDate[r.forecast_date].published_at)) {
                byDate[r.forecast_date] = r;
            }
        }
        return Object.values(byDate).map(buildCitation);
    }

    // For single-result queries (forecast_for_date, extreme_value, etc.), return first result
    return [buildCitation(results[0])];
}

/**
 * Generate a fallback answer when LLM response generation fails.
 */
function generateFallbackAnswer(intent, results) {
    if (!results || results.length === 0) {
        return {
            success: true,
            answer: "I couldn't find any weather data matching your question. The data may not be available for that time period.",
            citations: [],
            query_type: intent.query_type,
        };
    }

    let answer = "";
    const citations = [];

    switch (intent.query_type) {
        case "current_conditions":
        case "forecast_for_date": {
            const r = results[0];
            const date = formatDateLong(r.forecast_date);
            answer = `The forecast for ${date}: ${r.description}.`;
            if (r.min_temp != null && r.max_temp != null) {
                answer += ` Temperature: ${r.min_temp}°C to ${r.max_temp}°C.`;
            }
            if (r.wind_speed != null || r.wind_direction) {
                const windParts = [r.wind_speed != null ? `${r.wind_speed}mph` : null, r.wind_direction].filter(Boolean);
                if (windParts.length > 0) {
                    answer += ` Wind: ${windParts.join(" ")}.`;
                }
            }
            if (r.rainfall && r.rainfall !== "0") {
                answer += ` Rainfall: ${formatRainfall(r.rainfall)}.`;
            }
            if (r.visibility) {
                answer += ` Visibility: ${r.visibility}.`;
            }
            citations.push(buildCitation(r));
            break;
        }

        case "last_day_with":
        case "first_day_with": {
            const r = results[0];
            const date = formatDateLong(r.forecast_date);
            const qualifier = intent.query_type === "last_day_with" ? "most recent" : "next";
            answer = `The ${qualifier} matching day was ${date}. The forecast was: ${r.description}.`;
            if (r.min_temp != null && r.max_temp != null) {
                answer += ` Temperature: ${r.min_temp}°C to ${r.max_temp}°C.`;
            }
            citations.push(buildCitation(r));
            break;
        }

        case "last_day_without": {
            const r = results[0];
            const date = formatDateLong(r.forecast_date);
            answer = `The most recent day without that condition was ${date}. The forecast was: ${r.description}.`;
            if (r.min_temp != null && r.max_temp != null) {
                answer += ` Temperature: ${r.min_temp}°C to ${r.max_temp}°C.`;
            }
            citations.push(buildCitation(r));
            break;
        }

        case "average_over_range": {
            const r = results[0];
            const field = intent.fields?.[0] || "max_temp";
            const fieldLabel = formatFieldName(field);
            const avg = r.result !== null ? Math.round(r.result * 10) / 10 : "N/A";
            const unit = field.includes("temp") ? "°C" : field === "wind_speed" ? "mph" : "";

            if (r.count === 0) {
                answer = "No data available for that time period.";
            } else {
                answer = `The average ${fieldLabel} was ${avg}${unit} over ${r.count} forecast(s) from ${formatDateShort(r.start_date)} to ${formatDateShort(r.end_date)}.`;
            }
            break;
        }

        case "count_days_with": {
            const r = results[0];
            const count = r.count || 0;
            answer = `There ${count === 1 ? "was" : "were"} ${count} day${count === 1 ? "" : "s"} matching your criteria.`;
            break;
        }

        case "compare_dates": {
            if (results.length >= 2) {
                // Group by date and get latest for each
                const byDate = {};
                for (const r of results) {
                    if (!byDate[r.forecast_date] || new Date(r.published_at) > new Date(byDate[r.forecast_date].published_at)) {
                        byDate[r.forecast_date] = r;
                    }
                }
                const dates = Object.keys(byDate).sort();

                if (dates.length >= 2) {
                    const r1 = byDate[dates[0]];
                    const r2 = byDate[dates[1]];

                    const hasTemps = r1.min_temp != null && r1.max_temp != null && r2.min_temp != null && r2.max_temp != null;
                    if (hasTemps) {
                        const tempDiff = r2.max_temp - r1.max_temp;
                        const comparison =
                            tempDiff > 0 ? `${Math.abs(tempDiff)}°C warmer` : tempDiff < 0 ? `${Math.abs(tempDiff)}°C cooler` : "the same temperature";
                        answer = `Comparing ${formatDateShort(r1.forecast_date)} (${r1.min_temp}-${r1.max_temp}°C) vs ${formatDateShort(r2.forecast_date)} (${r2.min_temp}-${r2.max_temp}°C). ${formatDateShort(r2.forecast_date)} is ${comparison}.`;
                    } else {
                        answer = `Comparing ${formatDateShort(r1.forecast_date)}: ${r1.description} vs ${formatDateShort(r2.forecast_date)}: ${r2.description}.`;
                    }
                    citations.push(buildCitation(r1), buildCitation(r2));
                }
            } else if (results.length === 1) {
                const r = results[0];
                const tempInfo = r.min_temp != null && r.max_temp != null ? `: ${r.min_temp}-${r.max_temp}°C` : "";
                answer = `Only found data for ${formatDateShort(r.forecast_date)}${tempInfo}. ${r.description}`;
                citations.push(buildCitation(r));
            }
            break;
        }

        case "extreme_value": {
            const r = results[0];
            const date = formatDateLong(r.forecast_date);
            const field = intent.fields?.[0] || "max_temp";
            const value = r[field];
            const unit = field.includes("temp") ? "°C" : field === "wind_speed" ? "mph" : "";
            if (value != null) {
                answer = `The ${intent.extreme === "min" ? "lowest" : "highest"} ${formatFieldName(field)} was ${value}${unit} on ${date}.`;
            } else {
                answer = `Found a matching day on ${date}: ${r.description}`;
            }
            citations.push(buildCitation(r));
            break;
        }

        case "list_days_with": {
            const byDate = {};
            for (const r of results) {
                if (!byDate[r.forecast_date] || new Date(r.published_at) > new Date(byDate[r.forecast_date].published_at)) {
                    byDate[r.forecast_date] = r;
                }
            }
            const uniqueResults = Object.values(byDate);
            const dateList = uniqueResults.map((r) => formatDateShort(r.forecast_date)).join(", ");
            answer = `Found ${uniqueResults.length} matching day${uniqueResults.length === 1 ? "" : "s"}: ${dateList}.`;
            uniqueResults.forEach((r) => citations.push(buildCitation(r)));
            break;
        }

        case "period_summary": {
            const byDate = {};
            for (const r of results) {
                if (!byDate[r.forecast_date] || new Date(r.published_at) > new Date(byDate[r.forecast_date].published_at)) {
                    byDate[r.forecast_date] = r;
                }
            }
            const uniqueResults = Object.values(byDate).sort((a, b) => a.forecast_date.localeCompare(b.forecast_date));
            const summaries = uniqueResults.map((r) => {
                const tempInfo = r.min_temp != null && r.max_temp != null ? `${r.min_temp}-${r.max_temp}°C, ` : "";
                return `${formatDateShort(r.forecast_date)}: ${tempInfo}${r.description}`;
            });
            answer = summaries.join(". ");
            uniqueResults.forEach((r) => citations.push(buildCitation(r)));
            break;
        }

        case "max_streak": {
            const r = results[0];
            const days = r.streak_length || 0;
            if (days === 0) {
                answer = "No matching streak found.";
            } else {
                answer = `The longest streak was ${days} consecutive day${days === 1 ? "" : "s"}, from ${formatDateShort(r.start_date)} to ${formatDateShort(r.end_date)}.`;
            }
            break;
        }

        default:
            answer = "Query completed but result format is unknown.";
    }

    return {
        success: true,
        answer,
        citations,
        query_type: intent.query_type,
    };
}

function buildCitation(forecast) {
    const citation = {
        forecast_date: forecast.forecast_date,
        published_at: forecast.published_at,
        description: forecast.description,
    };
    // Only include temperature if both values are available
    if (forecast.min_temp != null && forecast.max_temp != null) {
        citation.min_temp = forecast.min_temp;
        citation.max_temp = forecast.max_temp;
    }
    return citation;
}

