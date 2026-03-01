import { z } from "zod";

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

// Question input validation - sanitises user input
export const QuestionInputSchema = z.object({
    question: z
        .string()
        .min(3, "Question too short")
        .max(500, "Question too long")
        .refine((q) => !/<[^>]*>/.test(q), "Invalid request")
        .refine((q) => !/[<>";]/.test(q), "Invalid request")
        .refine((q) => !q.includes("--"), "Invalid request")
        .refine((q) => !INJECTION_PATTERNS.some((p) => p.test(q)), "Invalid request"),
});
