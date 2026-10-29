-- Tasks: how often each needed you, how long they lived and how they ended
WITH per AS (SELECT task_id, COUNT(*) AS decisions FROM decisions GROUP BY task_id),
ended AS (SELECT task_id, json_extract(data, '$.how') AS how, json_extract(data, '$.lifeMs') AS life_ms, json_extract(data, '$.prs') AS prs
  FROM ev WHERE name = 'task-end'),
tasks AS (SELECT task_id FROM per UNION SELECT task_id FROM ended)
SELECT COALESCE(e.how, 'still open') AS ended, COUNT(*) AS tasks, ROUND(AVG(COALESCE(p.decisions, 0)), 1) AS avg_decisions,
  MAX(COALESCE(p.decisions, 0)) AS max_decisions, ROUND(AVG(e.life_ms) / 3600000.0, 1) AS avg_life_h, SUM(e.prs > 0) AS with_pr
FROM tasks t LEFT JOIN per p USING (task_id) LEFT JOIN ended e USING (task_id) GROUP BY 1 ORDER BY tasks DESC;
