-- Waiting time by how many decisions were open when one came up
SELECT CASE WHEN open_then <= 1 THEN '1' WHEN open_then <= 3 THEN '2–3' WHEN open_then <= 6 THEN '4–6' ELSE '7+' END AS open_decisions,
  COUNT(*) AS decisions, ROUND(AVG(wait_ms) / 1000.0, 1) AS avg_wait_s, ROUND(100.0 * SUM(via = 'terminal') / COUNT(*)) AS terminal_pct
FROM decisions WHERE wait_ms IS NOT NULL GROUP BY 1 ORDER BY MIN(open_then);
