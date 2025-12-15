import { z } from "zod";

// Whitelist of allowed query types
const QueryTypeSchema = z.enum([
    "forecast_for_date",
    "last_day_with",
    "last_day_without",
    "first_day_with",
    "average_over_range",
    "count_days_with",
    "compare_dates",
    "current_conditions",
    "extreme_value",
    "list_days_with",
    "period_summary",
    "max_streak",
]);

// Whitelist of allowed fields (database columns that can be queried)
const AllowedFieldSchema = z.enum([
    "min_temp",
    "max_temp",
    "wind_speed",
    "wind_direction",
    "description",
    "rainfall",
    "visibility",
]);

// Whitelist of allowed operators
const AllowedOperatorSchema = z.enum([
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "is_null",
    "is_not_null",
]);

// Numeric fields for validation
const NUMERIC_FIELDS = ["min_temp", "max_temp", "wind_speed"];

// Condition schema with strict validation
const ConditionSchema = z
    .object({
        field: AllowedFieldSchema,
        operator: AllowedOperatorSchema,
        value: z.union([z.string(), z.number(), z.null()]),
    })
    .refine(
        (data) => {
            const numericOperators = ["gt", "gte", "lt", "lte"];

            // Numeric operators only with numeric fields and number values
            if (numericOperators.includes(data.operator)) {
                return NUMERIC_FIELDS.includes(data.field) && typeof data.value === "number";
            }

            // contains only for string fields and string values
            if (data.operator === "contains") {
                return typeof data.value === "string";
            }

            // is_null/is_not_null should have null value
            if (data.operator === "is_null" || data.operator === "is_not_null") {
                return data.value === null;
            }

            return true;
        },
        {
            message: "Invalid operator/field/value combination",
        }
    );

// Date validation - accepts YYYY-MM-DD or special keywords
const DateStringSchema = z.string().refine(
    (val) => {
        if (val === "today" || val === "first_record" || val === "last_record") {
            return true;
        }
        // Must be YYYY-MM-DD format and valid date
        if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
            return false;
        }
        const date = new Date(val);
        return !isNaN(date.getTime());
    },
    {
        message: "Date must be YYYY-MM-DD format or special keyword (today, first_record, last_record)",
    }
);

// Date range schema
const DateRangeSchema = z
    .object({
        start: DateStringSchema,
        end: DateStringSchema,
    })
    .refine(
        (data) => {
            // If both are actual dates, start must be <= end
            const startIsDate = /^\d{4}-\d{2}-\d{2}$/.test(data.start);
            const endIsDate = /^\d{4}-\d{2}-\d{2}$/.test(data.end);

            if (startIsDate && endIsDate) {
                return new Date(data.start) <= new Date(data.end);
            }
            return true;
        },
        {
            message: "Start date must not be after end date",
        }
    );

// Main query intent schema - validates LLM output
export const QueryIntentSchema = z
    .object({
        query_type: QueryTypeSchema,
        conditions: z.array(ConditionSchema).max(5).optional(),
        date_range: DateRangeSchema.optional(),
        fields: z.array(AllowedFieldSchema).max(3).optional(),
        aggregation: z.enum(["avg", "min", "max", "count", "sum"]).optional(),
        target_date: DateStringSchema.optional(),
        compare_dates: z.tuple([DateStringSchema, DateStringSchema]).optional(),
        limit: z.number().int().min(1).max(10).optional(),
        extreme: z.enum(["max", "min"]).optional(),
    })
    .refine(
        (data) => {
            // Query-type specific validation
            switch (data.query_type) {
                case "forecast_for_date":
                    return data.target_date !== undefined;
                case "compare_dates":
                    return data.compare_dates !== undefined;
                case "average_over_range":
                case "count_days_with":
                case "list_days_with":
                case "period_summary":
                    return data.date_range !== undefined;
                case "extreme_value":
                    return data.date_range !== undefined && data.fields?.length > 0 && data.extreme !== undefined;
                case "max_streak":
                    return data.date_range !== undefined && data.conditions?.length > 0;
                case "current_conditions":
                    // current_conditions doesn't require target_date, it uses today
                    return true;
                default:
                    return true;
            }
        },
        {
            message: "Missing required fields for query type",
        }
    );

// Schema for unanswerable response from LLM (non-weather questions)
export const UnanswerableSchema = z.object({
    error: z.literal("unanswerable"),
    reason: z.string().optional(),
});

// Schema for rejected response from LLM (security/injection attempts)
export const RejectedSchema = z.object({
    error: z.literal("rejected"),
    reason: z.string().optional(),
});

// Combined LLM response schema (valid intent, unanswerable, or rejected)
export const LLMResponseSchema = z.union([QueryIntentSchema, UnanswerableSchema, RejectedSchema]);

// Suspicious patterns that indicate prompt injection attempts
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|above|prior)/i,
    /disregard\s+(all\s+)?(previous|above|prior|your)/i,
    /forget\s+(all\s+)?(previous|above|prior|your)/i,
    /pretend\s+(you\s+are|to\s+be|you're)/i,
    /act\s+as\s+(if|a|an|though)/i,
    /you\s+are\s+now/i,
    /new\s+instructions/i,
    /system\s*prompt/i,
    /reveal\s+(your|the)\s+(instructions|prompt|rules)/i,
    /what\s+are\s+your\s+(instructions|rules)/i,
    /repeat\s+(your|the|back)\s+(instructions|prompt|rules)/i,
    /override\s+(your|the|all)/i,
    /bypass\s+(your|the|all)/i,
    /jailbreak/i,
    /DAN\s*mode/i,
    /developer\s*mode/i,
    /\bbase64\b/i,
    /\bhex\s*encode/i,
    /\brot13\b/i,
];

// Question input validation - sanitizes user input
export const QuestionInputSchema = z.object({
    question: z
        .string()
        .min(3, "Question too short")
        .max(500, "Question too long")
        .refine((q) => !/<[^>]*>/.test(q), "Invalid request")
        .refine((q) => !/[<>";]/.test(q), "Invalid request") // Allow apostrophes for contractions (What's, it's)
        .refine((q) => !q.includes("--"), "Invalid request")
        .refine((q) => !INJECTION_PATTERNS.some((p) => p.test(q)), "Invalid request"),
});

// Export type definitions for use elsewhere
export const ALLOWED_FIELDS = [
    "min_temp",
    "max_temp",
    "wind_speed",
    "wind_direction",
    "description",
    "rainfall",
    "visibility",
];

export const ALLOWED_OPERATORS = [
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "is_null",
    "is_not_null",
];

export const QUERY_TYPES = [
    "forecast_for_date",
    "last_day_with",
    "last_day_without",
    "first_day_with",
    "average_over_range",
    "count_days_with",
    "compare_dates",
    "current_conditions",
    "extreme_value",
    "list_days_with",
    "period_summary",
    "max_streak",
];
