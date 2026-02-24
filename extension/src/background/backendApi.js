import { config } from './config.js';
import { getStorage } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('BackendAPI');

export async function getSystemToken() {
  const store = await getStorage(['systemToken']);
  return store.systemToken || null;
}

async function backendFetch(path, systemToken, options = {}) {
  const store = await getStorage(['backendUrl']);
  const baseUrl = store.backendUrl || config.BACKEND_BASE_URL;
  const url = `${baseUrl}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${systemToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Backend ${options.method || 'GET'} ${path} failed: ${response.status}`);
  }

  return response;
}

export async function fetchPendingTasks(systemToken) {
  logger.info('Fetching pending tasks');

  try {
    const response = await backendFetch('/tasks/pending', systemToken);
    const data = await response.json();
    const tasks = data.tasks || [];
    logger.info(`Fetched ${tasks.length} pending task(s)`);
    return tasks;
  } catch (err) {
    logger.error('Failed to fetch tasks:', err.message);
    throw err;
  }
}

export async function submitTaskResult(systemToken, taskId, results) {
  logger.info(`Submitting result for task ${taskId}`);

  try {
    const response = await backendFetch(`/tasks/${taskId}/result`, systemToken, {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        results,
        submitted_at: new Date().toISOString(),
      }),
    });

    logger.info(`Task ${taskId} result submitted`);
    return response.json();
  } catch (err) {
    logger.error(`Submit failed for task ${taskId}:`, err.message);
    throw err;
  }
}

export async function reportTaskError(systemToken, taskId, errorMessage) {
  logger.warn(`Reporting error for task ${taskId}: ${errorMessage}`);

  try {
    await backendFetch(`/tasks/${taskId}/error`, systemToken, {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        error: errorMessage,
        reported_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    logger.error(`Failed to report error for task ${taskId}:`, err.message);
  }
}
