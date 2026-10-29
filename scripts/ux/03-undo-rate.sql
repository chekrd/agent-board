-- Sends taken back with Undo, by action, and how far into the 5 s hold
WITH s AS (SELECT json_extract(data, '$.action') AS action, COUNT(*) AS sends FROM ev WHERE name = 'send' GROUP BY 1),
u AS (SELECT json_extract(data, '$.action') AS action, COUNT(*) AS undos, ROUND(AVG(json_extract(data, '$.afterMs')) / 1000.0, 1) AS avg_into_hold_s
  FROM ev WHERE name = 'undo' GROUP BY 1),
f AS (SELECT json_extract(data, '$.action') AS action, COUNT(*) AS failed FROM ev WHERE name = 'send-failed' GROUP BY 1)
SELECT s.action, s.sends, COALESCE(u.undos, 0) AS undos, ROUND(100.0 * COALESCE(u.undos, 0) / s.sends) AS undo_pct, u.avg_into_hold_s,
  COALESCE(f.failed, 0) AS failed
FROM s LEFT JOIN u USING (action) LEFT JOIN f USING (action) ORDER BY s.sends DESC;
