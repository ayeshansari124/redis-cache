import { pool } from "./db.js";
import { redis } from "./redis.js";

const CACHE_TTL_SECONDS = 300;

function productCacheKey(id) {
  return `product:${id}`;
}

export async function getProductById(id) {
  const key = productCacheKey(id);

  // 1. Try Redis first.
  const cached = await redis.get(key);

  if (cached !== null) {
    return {
      product: JSON.parse(cached),
      cache: "HIT",
    };
  }

  // 2. Cache miss: query PostgreSQL.
  const result = await pool.query(
    `SELECT id, name, price, updated_at
     FROM products
     WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) {
    return {
      product: null,
      cache: "MISS",
    };
  }

  const product = result.rows[0];

  // 3. Store the result in Redis.
  await redis.set(key, JSON.stringify(product), {
    EX: CACHE_TTL_SECONDS,
  });

  // 4. Return the database result.
  return {
    product,
    cache: "MISS",
  };
}

export async function updateProduct(id, name, price) {
  const result = await pool.query(
    `UPDATE products
     SET name = $1,
         price = $2,
         updated_at = NOW()
     WHERE id = $3
     RETURNING id, name, price, updated_at`,
    [name, price, id],
  );

  if (result.rows.length === 0) {
    return null;
  }

  // Database update succeeded; invalidate the old cached value.
  await redis.del(productCacheKey(id));

  return result.rows[0];
}

export async function invalidateProductCache(id) {
  await redis.del(productCacheKey(id));
}
