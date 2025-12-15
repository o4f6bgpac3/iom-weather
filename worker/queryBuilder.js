/**
 * Query Builder Module
 *
 * Converts validated query intents into safe SQL queries for weather data.
 * All queries use parameterized statements to prevent SQL injection.
 *
 * Security: This module operates on Zod-validated intents. Never pass
 * unvalidated user input directly to these functions.
 */

/**
 * Whitelist of allowed database field names.
 * This ensures we never use untrusted field names in SQL queries.
 * Only fields listed here can be queried.
 */
const FIELD_MAP = {
    min_temp: "min_temp",
    max_temp: "max_temp",
    wind_speed: "wind_speed",
    wind_direction: "wind_direction",
    description: "description",
    rainfall: "rainfall",
    visibility: "visibility",
};

/**
 * Generates a SQL expression to extract a numeric value from a field.
 *
 * Most fields can be simply CAST to REAL, but the rainfall field requires
 * special handling because it's stored as text in various formats.
 *
 * ## Rainfall Data Formats
 *
 * The rainfall field stores precipitation data in several text formats:
 *
 * | Format            | Example              | Extracted Value |
 * |-------------------|----------------------|-----------------|
 * | Zero/empty        | "0", "", null        | 0               |
 * | Simple value      | "5"                  | 5               |
 * | Simple range      | "5-10"               | 10 (upper bound)|
 * | Range with units  | "5-10mm"             | 10              |
 * | Range with hills  | "5-10, 10-20 hills"  | 20 (max of all) |
 *
 * ## Why Extract Upper Bound?
 *
 * When comparing rainfall (e.g., "find the wettest day"), we use the upper
 * bound of ranges because:
 * 1. It represents the maximum possible precipitation
 * 2. It's more useful for "extreme value" queries
 * 3. Simple values work correctly (no range = value itself)
 *
 * ## SQLite Limitations
 *
 * SQLite lacks REVERSE() and advanced string functions, so we handle each
 * format with nested CASE statements and SUBSTR/INSTR combinations.
 *
 * @param {string} field - Database field name (from FIELD_MAP)
 * @returns {string} - SQL expression that evaluates to a numeric value
 */
function getNumericFieldExpr(field) {
    if (field === "rainfall") {
        // Build a CASE expression to handle each rainfall format
        return `CASE
            -- Case 1: Null, empty, or zero -> 0
            WHEN ${field} IS NULL OR TRIM(${field}) = '' OR ${field} = '0' THEN 0

            -- Case 2: Simple value without dash (e.g., "5" or "5mm")
            -- Remove units and cast to number
            WHEN ${field} NOT LIKE '%-%' THEN
                CAST(TRIM(REPLACE(REPLACE(REPLACE(REPLACE(${field}, ' mm', ''), 'mm', ''), ' hills', ''), 'hills', '')) AS REAL)

            -- Case 3: Simple range without comma (e.g., "5-10" or "5-10mm")
            -- Extract the upper bound (number after the dash)
            WHEN ${field} NOT LIKE '%,%' THEN
                CAST(TRIM(REPLACE(REPLACE(REPLACE(
                    SUBSTR(${field}, INSTR(${field}, '-') + 1),
                    ' mm', ''), 'mm', ''), ' hills', ''
                )) AS REAL)

            -- Case 4: Complex format with comma (e.g., "5-10, 10-20 hills")
            -- Parse both ranges and return the maximum upper bound
            ELSE
                (SELECT MAX(val) FROM (
                    -- First range: extract upper bound before the comma
                    SELECT CAST(TRIM(SUBSTR(
                        REPLACE(REPLACE(REPLACE(${field}, ' mm', ''), 'mm', ''), ' hills', ''),
                        INSTR(REPLACE(REPLACE(REPLACE(${field}, ' mm', ''), 'mm', ''), ' hills', ''), '-') + 1,
                        INSTR(REPLACE(REPLACE(REPLACE(${field}, ' mm', ''), 'mm', ''), ' hills', ''), ',')
                        - INSTR(REPLACE(REPLACE(REPLACE(${field}, ' mm', ''), 'mm', ''), ' hills', ''), '-') - 1
                    )) AS REAL) AS val
                    UNION ALL
                    -- Second range: extract upper bound after the comma
                    SELECT CAST(TRIM(REPLACE(SUBSTR(
                        SUBSTR(
                            REPLACE(REPLACE(REPLACE(${field}, ' mm', ''), 'mm', ''), ' hills', ''),
                            INSTR(REPLACE(REPLACE(REPLACE(${field}, ' mm', ''), 'mm', ''), ' hills', ''), ',') + 1
                        ),
                        INSTR(
                            SUBSTR(
                                REPLACE(REPLACE(REPLACE(${field}, ' mm', ''), 'mm', ''), ' hills', ''),
                                INSTR(REPLACE(REPLACE(REPLACE(${field}, ' mm', ''), 'mm', ''), ' hills', ''), ',') + 1
                            ),
                            '-'
                        ) + 1
                    ), 'hills', '')) AS REAL) AS val
                ))
        END`;
    }
    // For all other fields, simple cast to REAL
    return `CAST(${field} AS REAL)`;
}

/**
 * Build a safe SQL query from a validated intent.
 * IMPORTANT: Only call this with output from Zod validation.
 *
 * @param {Object} validatedIntent - Intent that has passed Zod validation
 * @returns {{sql: string, params: Array}} - SQL query and bound parameters
 */
export function buildQuery(validatedIntent) {
    const { query_type, conditions, date_range, target_date, fields, compare_dates } = validatedIntent;

    let sql = "";
    const params = [];

    switch (query_type) {
        case "current_conditions": {
            sql = `
                SELECT * FROM forecast_items
                WHERE forecast_date = date('now')
                ORDER BY published_at DESC
                LIMIT 1
            `;
            break;
        }

        case "forecast_for_date": {
            sql = `
                SELECT * FROM forecast_items
                WHERE forecast_date = ?
                ORDER BY published_at DESC
                LIMIT 1
            `;
            params.push(resolveDate(target_date));
            break;
        }

        case "last_day_with": {
            const dateClause = buildDateRangeClause(date_range, params);
            const whereClause = buildConditionClause(conditions, params, false);

            sql = `
                WITH ${buildLatestSameDayCTE(dateClause)}
                SELECT * FROM latest_same_day
                WHERE ${whereClause}
                ORDER BY forecast_date DESC
                LIMIT 1
            `;
            break;
        }

        case "last_day_without": {
            const dateClause = buildDateRangeClause(date_range, params);
            const whereClause = buildConditionClause(conditions, params, true);

            sql = `
                WITH ${buildLatestSameDayCTE(dateClause)}
                SELECT * FROM latest_same_day
                WHERE ${whereClause}
                ORDER BY forecast_date DESC
                LIMIT 1
            `;
            break;
        }

        case "first_day_with": {
            const dateClause = buildDateRangeClause(date_range, params);
            const whereClause = buildConditionClause(conditions, params, false);

            sql = `
                WITH ${buildLatestSameDayCTE(dateClause)}
                SELECT * FROM latest_same_day
                WHERE ${whereClause}
                ORDER BY forecast_date ASC
                LIMIT 1
            `;
            break;
        }

        case "average_over_range": {
            const field = FIELD_MAP[fields?.[0]] || "max_temp";
            const dateClause = buildDateRangeClause(date_range, params);

            sql = `
                WITH ${buildLatestSameDayCTE(dateClause)}
                SELECT
                    AVG(CAST(${field} AS REAL)) as result,
                    COUNT(*) as count,
                    MIN(forecast_date) as start_date,
                    MAX(forecast_date) as end_date
                FROM latest_same_day
            `;
            break;
        }

        case "count_days_with": {
            const dateClause = buildDateRangeClause(date_range, params);
            const whereClause = buildConditionClause(conditions, params, false);

            sql = `
                WITH ${buildLatestSameDayCTE(dateClause)}
                SELECT COUNT(*) as count
                FROM latest_same_day
                WHERE ${whereClause}
            `;
            break;
        }

        case "compare_dates": {
            sql = `
                WITH latest_same_day AS (
                    SELECT fc.*
                    FROM forecast_items fc
                    INNER JOIN (
                        SELECT forecast_date, MAX(published_at) as max_pub
                        FROM forecast_items
                        WHERE DATE(published_at) = forecast_date
                        AND forecast_date IN (?, ?)
                        GROUP BY forecast_date
                    ) latest ON fc.forecast_date = latest.forecast_date AND fc.published_at = latest.max_pub
                )
                SELECT * FROM latest_same_day
                ORDER BY forecast_date ASC
            `;
            params.push(resolveDate(compare_dates[0]));
            params.push(resolveDate(compare_dates[1]));
            break;
        }

        case "extreme_value": {
            const field = FIELD_MAP[fields?.[0]] || "max_temp";
            const dateClause = buildDateRangeClause(date_range, params);
            const extremeFunc = validatedIntent.extreme === "min" ? "MIN" : "MAX";
            const numericExpr = getNumericFieldExpr(field);

            sql = `
                WITH ${buildLatestSameDayCTE(dateClause)}
                SELECT * FROM latest_same_day
                WHERE (${numericExpr}) = (
                    SELECT ${extremeFunc}(${numericExpr})
                    FROM latest_same_day
                )
                ORDER BY forecast_date DESC
                LIMIT 1
            `;
            break;
        }

        case "list_days_with": {
            const dateClause = buildDateRangeClause(date_range, params);
            const whereClause = buildConditionClause(conditions, params, false);
            const limitVal = validatedIntent.limit || 7;

            sql = `
                WITH ${buildLatestSameDayCTE(dateClause)}
                SELECT * FROM latest_same_day
                WHERE ${whereClause}
                ORDER BY forecast_date ASC
                LIMIT ${Math.min(limitVal, 10)}
            `;
            break;
        }

        case "period_summary": {
            const dateClause = buildDateRangeClause(date_range, params);

            sql = `
                WITH ${buildLatestSameDayCTE(dateClause)}
                SELECT * FROM latest_same_day
                ORDER BY forecast_date ASC
            `;
            break;
        }

        case "max_streak": {
            // Find the longest streak of consecutive days matching a condition
            // Uses gaps-and-islands technique with julianday for date arithmetic
            const dateClause = buildDateRangeClause(date_range, params);
            const whereClause = buildConditionClause(conditions, params, false);

            sql = `
                WITH ${buildLatestSameDayCTE(dateClause)},
                matching_days AS (
                    -- Filter to days matching the condition, assign row numbers
                    -- The streak_group formula identifies consecutive day sequences:
                    -- julianday gives us sequential numbers for dates (e.g., 2460678.5 for 2025-01-15)
                    -- ROW_NUMBER gives us 1, 2, 3... for matching rows
                    -- When dates are consecutive, the difference stays constant
                    -- When there's a gap, the difference changes (new group)
                    SELECT
                        forecast_date,
                        julianday(forecast_date) - ROW_NUMBER() OVER (ORDER BY forecast_date) as streak_group
                    FROM latest_same_day
                    WHERE ${whereClause}
                ),
                streaks AS (
                    -- Group consecutive days and count streak lengths
                    SELECT
                        COUNT(*) as streak_length,
                        MIN(forecast_date) as start_date,
                        MAX(forecast_date) as end_date
                    FROM matching_days
                    GROUP BY streak_group
                )
                SELECT streak_length, start_date, end_date
                FROM streaks
                ORDER BY streak_length DESC
                LIMIT 1
            `;
            break;
        }

        default:
            throw new Error(`Unknown query type: ${query_type}`);
    }

    return { sql, params };
}

/**
 * Build a CTE that gets the best forecast for each day.
 *
 * For each forecast_date, this selects the most appropriate forecast record:
 * 1. Prioritizes "same-day" forecasts (published on the forecast date itself)
 * 2. Falls back to the most recent earlier forecast if no same-day forecast exists
 *
 * This ensures we use the most accurate prediction available for each day,
 * since forecasts made on the day itself are typically more accurate than
 * those made days in advance.
 *
 * @param {string|null} dateClause - SQL WHERE clause for filtering date range
 * @returns {string} - SQL CTE definition
 */
function buildLatestSameDayCTE(dateClause) {
    return `
        latest_same_day AS (
            SELECT fc.*
            FROM forecast_items fc
            INNER JOIN (
                -- Find the best published_at for each forecast_date:
                -- Prefer same-day forecasts, fall back to most recent earlier forecast
                SELECT
                    forecast_date,
                    COALESCE(
                        MAX(CASE WHEN DATE(published_at) = forecast_date THEN published_at END),
                        MAX(CASE WHEN DATE(published_at) < forecast_date THEN published_at END)
                    ) as best_pub
                FROM forecast_items
                ${dateClause ? "WHERE " + dateClause : ""}
                GROUP BY forecast_date
            ) best ON fc.forecast_date = best.forecast_date AND fc.published_at = best.best_pub
        )`;
}

/**
 * Build WHERE clause from conditions.
 */
function buildConditionClause(conditions, params, negate = false) {
    if (!conditions || conditions.length === 0) {
        return "1=1";
    }

    const clauses = conditions.map((cond) => {
        const field = FIELD_MAP[cond.field];
        if (!field) {
            throw new Error(`Invalid field: ${cond.field}`);
        }

        let clause = "";

        switch (cond.operator) {
            case "eq":
                clause = `${field} = ?`;
                params.push(cond.value);
                break;
            case "ne":
                clause = `${field} != ?`;
                params.push(cond.value);
                break;
            case "gt":
                clause = `CAST(${field} AS REAL) > ?`;
                params.push(cond.value);
                break;
            case "gte":
                clause = `CAST(${field} AS REAL) >= ?`;
                params.push(cond.value);
                break;
            case "lt":
                clause = `CAST(${field} AS REAL) < ?`;
                params.push(cond.value);
                break;
            case "lte":
                clause = `CAST(${field} AS REAL) <= ?`;
                params.push(cond.value);
                break;
            case "contains":
                clause = `${field} LIKE ?`;
                // Escape LIKE special characters and wrap with wildcards
                const escapedValue = String(cond.value).replace(/[%_]/g, "\\$&");
                params.push(`%${escapedValue}%`);
                break;
            case "is_null":
                clause = `${field} IS NULL`;
                break;
            case "is_not_null":
                clause = `${field} IS NOT NULL`;
                break;
            default:
                throw new Error(`Invalid operator: ${cond.operator}`);
        }

        return negate ? `NOT (${clause})` : clause;
    });

    return clauses.join(" AND ");
}

/**
 * Build date range clause.
 */
function buildDateRangeClause(date_range, params) {
    if (!date_range) return null;

    const clauses = [];

    if (date_range.start === "first_record") {
        // No lower bound needed
    } else if (date_range.start === "today") {
        clauses.push("forecast_date >= date('now')");
    } else {
        clauses.push("forecast_date >= ?");
        params.push(date_range.start);
    }

    if (date_range.end === "last_record") {
        // No upper bound needed
    } else if (date_range.end === "today") {
        clauses.push("forecast_date <= date('now')");
    } else {
        clauses.push("forecast_date <= ?");
        params.push(date_range.end);
    }

    return clauses.length > 0 ? clauses.join(" AND ") : null;
}

/**
 * Resolve special date keywords to actual dates.
 */
function resolveDate(dateStr) {
    if (dateStr === "today") {
        return new Date().toISOString().split("T")[0];
    }
    return dateStr;
}
