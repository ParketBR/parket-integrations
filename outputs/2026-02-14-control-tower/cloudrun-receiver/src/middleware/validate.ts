import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";
import { createLogger } from "../config/logger.js";

const log = createLogger("middleware:validate");

/**
 * Express middleware that validates request body against a Zod schema.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errors = result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));

      log.warn("Payload validation failed", {
        path: req.path,
        errors,
      });

      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Invalid payload",
        details: errors,
      });
      return;
    }

    req.body = result.data;
    next();
  };
}
