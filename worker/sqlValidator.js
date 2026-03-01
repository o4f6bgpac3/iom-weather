/**
 * SQL Validator Module
 *
 * Validates LLM-generated SQL before execution against D1.
 * Lightweight approach suited to a fixed, known schema.
 */

const ALLOWED_TABLES = ["weather", "tides"];

const DANGEROUS_KEYWORDS = [
    "sqlite_master",
    "sqlite_schema",
    "sqlite_temp_master",
    "pragma",
    "attach",
    "detach",
];

const WRITE_STATEMENTS = [
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "create",
    "replace",
    "truncate",
    "merge",
];

/**
 * Validate an LLM-generated SQL string.
 *
 * @param {string} sql - Raw SQL from the LLM
 * @returns {{ valid: boolean, error?: string, sanitisedSql: string }}
 */
export function validateSQL(sql) {
    if (!sql || typeof sql !== "string") {
        return { valid: false, error: "Empty or non-string SQL", sanitisedSql: "" };
    }

    const trimmed = sql.trim().replace(/;+\s*$/, "");

    // Reject multiple statements (semicolons within the body)
    if (trimmed.includes(";")) {
        return { valid: false, error: "Multiple statements not allowed", sanitisedSql: "" };
    }

    const lower = trimmed.toLowerCase();

    // Must start with SELECT
    if (!lower.startsWith("select")) {
        return { valid: false, error: "Only SELECT statements are allowed", sanitisedSql: "" };
    }

    // Block write statements anywhere in the query
    for (const keyword of WRITE_STATEMENTS) {
        const pattern = new RegExp(`\\b${keyword}\\b`, "i");
        if (pattern.test(lower)) {
            return { valid: false, error: `Forbidden keyword: ${keyword.toUpperCase()}`, sanitisedSql: "" };
        }
    }

    // Block dangerous keywords
    for (const keyword of DANGEROUS_KEYWORDS) {
        if (lower.includes(keyword)) {
            return { valid: false, error: `Forbidden keyword: ${keyword}`, sanitisedSql: "" };
        }
    }

    // Extract table references from FROM and JOIN clauses
    const tablePattern = /\b(?:from|join)\s+(\w+)/gi;
    let match;
    while ((match = tablePattern.exec(trimmed)) !== null) {
        const table = match[1].toLowerCase();
        // Skip SQL keywords that might follow FROM in subqueries
        if (table === "select" || table === "lateral") continue;
        if (!ALLOWED_TABLES.includes(table)) {
            return { valid: false, error: `Table not allowed: ${match[1]}`, sanitisedSql: "" };
        }
    }

    // Enforce LIMIT if not present
    let sanitisedSql = trimmed;
    if (!/\blimit\b/i.test(sanitisedSql)) {
        sanitisedSql += " LIMIT 50";
    }

    return { valid: true, sanitisedSql };
}
