-- Slow responses (input to next paint ≥ 200 ms), the main thread held up, crashes, lost connections and reloads
SELECT name AS what, COALESCE(data ->> '$.control', data ->> '$.event', data ->> '$.error', data ->> '$.state', '') AS detail,
  COALESCE(data ->> '$.screen', '') AS screen, COUNT(*) AS n, MAX(data ->> '$.ms') AS max_ms, ROUND(AVG(data ->> '$.ms')) AS avg_ms
FROM ev WHERE name IN ('slow', 'freeze', 'crash', 'link', 'reload', 'reload-offered') GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 30;
