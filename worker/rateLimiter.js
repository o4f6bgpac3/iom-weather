import { CONFIG } from "./config.js";

const { maxRequests: RATE_LIMIT, windowSeconds: WINDOW_SECONDS } = CONFIG.rateLimit;

/**
 * Check if a request is allowed under rate limiting rules.
 * Uses Cloudflare KV to track request counts per IP.
 *
 * @param {Request} request - The incoming request
 * @param {Object} env - Environment bindings including RATE_LIMIT_KV
 * @returns {Promise<{allowed: boolean, remaining: number}>}
 */
export async function checkRateLimit(request, env) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = `ratelimit:ask:${ip}`;

    try {
        // Get current count from KV
        const data = await env.RATE_LIMIT_KV.get(key, { type: "json" });
        const now = Math.floor(Date.now() / 1000);

        if (!data) {
            // First request from this IP
            await env.RATE_LIMIT_KV.put(
                key,
                JSON.stringify({
                    count: 1,
                    windowStart: now,
                }),
                { expirationTtl: WINDOW_SECONDS }
            );

            return { allowed: true, remaining: RATE_LIMIT - 1 };
        }

        const { count, windowStart } = data;

        // Check if window has expired
        if (now - windowStart >= WINDOW_SECONDS) {
            // Start new window
            await env.RATE_LIMIT_KV.put(
                key,
                JSON.stringify({
                    count: 1,
                    windowStart: now,
                }),
                { expirationTtl: WINDOW_SECONDS }
            );

            return { allowed: true, remaining: RATE_LIMIT - 1 };
        }

        // Within window - check count
        if (count >= RATE_LIMIT) {
            return { allowed: false, remaining: 0 };
        }

        // Increment count
        await env.RATE_LIMIT_KV.put(
            key,
            JSON.stringify({
                count: count + 1,
                windowStart,
            }),
            { expirationTtl: WINDOW_SECONDS }
        );

        return { allowed: true, remaining: RATE_LIMIT - count - 1 };
    } catch (error) {
        console.error("Rate limit check failed:", error);
        // On error, allow the request but log it
        return { allowed: true, remaining: RATE_LIMIT - 1 };
    }
}
