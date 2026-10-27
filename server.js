import express from "express";
import "dotenv/config";

import { redis, connectRedis } from "./redis.js";
import { pool } from "./db.js";

import {
  getProductById,
  updateProduct,
  invalidateProductCache,
} from "./productService.js";

const app = express();

app.use(express.json());

function parseProductId(value) {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const id = Number(value);

  if (!Number.isSafeInteger(id)) {
    return null;
  }

  return id;
}

app.get("/api/products/:id", async (req, res, next) => {
  const id = parseProductId(req.params.id);

  if (id === null) {
    return res.status(400).json({
      error: "Invalid product ID",
    });
  }

  try {
    let result;

    try {
      result = await getProductById(id);
    } catch (error) {
      // Cache unavailable? Fall back to PostgreSQL.
      console.error("Cache lookup failed:", error);

      const dbResult = await pool.query(
        `SELECT id, name, price, updated_at
         FROM products
         WHERE id = $1`,
        [id]
      );

      result = {
        product: dbResult.rows[0] ?? null,
        cache: "BYPASS",
      };
    }

    res.setHeader("X-Cache", result.cache);

    if (!result.product) {
      return res.status(404).json({
        error: "Product not found",
      });
    }

    return res.json(result.product);
  } catch (error) {
    next(error);
  }
});

app.put("/api/products/:id", async (req, res, next) => {
  const id = parseProductId(req.params.id);
  const { name, price } = req.body;

  if (id === null) {
    return res.status(400).json({
      error: "Invalid product ID",
    });
  }

  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    price < 0
  ) {
    return res.status(400).json({
      error: "Valid name and non-negative price are required",
    });
  }

  try {
    const product = await updateProduct(
      id,
      name.trim(),
      price
    );

    if (!product) {
      return res.status(404).json({
        error: "Product not found",
      });
    }

    return res.json(product);
  } catch (error) {
    next(error);
  }
});

app.delete(
  "/api/products/:id/cache",
  async (req, res, next) => {
    const id = parseProductId(req.params.id);

    if (id === null) {
      return res.status(400).json({
        error: "Invalid product ID",
      });
    }

    try {
      await invalidateProductCache(id);

      return res.json({
        message: "Product cache invalidated",
      });
    } catch (error) {
      next(error);
    }
  }
);

app.use((error, req, res, next) => {
  console.error(error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "Internal server error",
  });
});

const port = Number(process.env.PORT) || 3000;

await connectRedis();

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

async function shutdown() {
  server.close(async () => {
    try {
      await Promise.all([
        redis.quit(),
        pool.end(),
      ]);
    } catch (error) {
      console.error("Shutdown error:", error);
    }

    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);