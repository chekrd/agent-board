-- Second-opinion confidence against what you did with it, for decisions answered on the board while one was ready
SELECT CASE WHEN confidence >= 90 THEN '90–100' WHEN confidence >= 70 THEN '70–89' WHEN confidence >= 50 THEN '50–69' ELSE 'under 50' END AS confidence,
  COUNT(*) AS decisions, SUM(followed = 'as-is') AS taken_as_is, SUM(followed = 'edited') AS edited,
  SUM(followed IS NULL OR followed = 'ignored') AS not_used, ROUND(100.0 * SUM(followed IN ('as-is', 'edited')) / COUNT(*)) AS used_pct
FROM decisions WHERE confidence IS NOT NULL AND answered_at IS NOT NULL GROUP BY 1 ORDER BY MIN(confidence) DESC;
