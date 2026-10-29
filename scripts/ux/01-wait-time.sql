-- How long decisions waited for you (asked → closed) and how long you took once the card showed, by kind and where answered
WITH w AS (
  SELECT kind, via, wait_ms, ROW_NUMBER() OVER (PARTITION BY kind, via ORDER BY wait_ms) AS n, COUNT(*) OVER (PARTITION BY kind, via) AS total
  FROM decisions WHERE wait_ms IS NOT NULL
), t AS (
  SELECT kind, via, decide_ms, ROW_NUMBER() OVER (PARTITION BY kind, via ORDER BY decide_ms) AS n, COUNT(*) OVER (PARTITION BY kind, via) AS total
  FROM decisions WHERE decide_ms IS NOT NULL
)
SELECT w.kind, w.via, w.total AS decisions,
  ROUND(MAX(CASE WHEN w.n = (w.total + 1) / 2 THEN w.wait_ms END) / 1000.0, 1) AS median_wait_s,
  ROUND(MAX(CASE WHEN w.n = (w.total * 9 + 9) / 10 THEN w.wait_ms END) / 1000.0, 1) AS p90_wait_s,
  (SELECT ROUND(MAX(CASE WHEN t.n = (t.total + 1) / 2 THEN t.decide_ms END) / 1000.0, 1) FROM t WHERE t.kind = w.kind AND t.via = w.via) AS median_decide_s
FROM w GROUP BY w.kind, w.via ORDER BY decisions DESC;
