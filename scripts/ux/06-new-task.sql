-- New task: dialogs opened against tasks created, and the choices made on the way
SELECT 'dialog opened' AS step, '' AS mode, COUNT(*) AS n, NULL AS with_model, NULL AS with_effort, NULL AS avg_prompt_chars,
  ROUND(AVG((SELECT c.data ->> '$.ms' FROM ev c WHERE c.name = 'dialog-close' AND c.page = o.page AND c.at > o.at AND c.data ->> '$.dialog' = 'new-task' ORDER BY c.at LIMIT 1)) / 1000.0, 1) AS avg_open_s
FROM ev o WHERE name = 'dialog-open' AND data ->> '$.dialog' = 'new-task'
UNION ALL
SELECT CASE WHEN data ->> '$.ok' THEN 'created' ELSE 'failed' END, data ->> '$.mode', COUNT(*), SUM(data ->> '$.model'), SUM(data ->> '$.effort'),
  ROUND(AVG(data ->> '$.promptChars')), NULL
FROM ev WHERE name = 'new-task' GROUP BY 1, 2;
