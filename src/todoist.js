const BASE = 'https://api.todoist.com/rest/v2';

function headers(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Request-Id': crypto.randomUUID(),
  };
}

async function request(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Todoist API ${res.status}: ${text}`);
  }
  return res.json();
}

// Projects
export const getProjects = (token) => request('GET', '/projects', token);
export const createProject = (token, name) => request('POST', '/projects', token, { name });

// Sections
export const getSections = (token, projectId) => request('GET', `/sections?project_id=${projectId}`, token);
export const createSection = (token, projectId, name, order) => request('POST', '/sections', token, { project_id: projectId, name, order });

// Tasks
export const getTasks = (token, projectId) => request('GET', `/tasks?project_id=${projectId}`, token);
export const createTask = (token, content, opts = {}) => request('POST', '/tasks', token, { content, ...opts });
export const updateTask = (token, id, opts) => request('POST', `/tasks/${id}`, token, opts);
export const closeTask = (token, id) => request('POST', `/tasks/${id}/close`, token);
export const deleteTask = (token, id) => request('DELETE', `/tasks/${id}`, token);

// Labels
export const getLabels = (token) => request('GET', '/labels', token);
export const createLabel = (token, name) => request('POST', '/labels', token, { name });

// Setup: ensure project + sections exist
export async function ensureSetup(token) {
  const projects = await getProjects(token);
  let project = projects.find(p => p.name === 'Priorities');
  if (!project) {
    project = await createProject(token, 'Priorities');
  }

  const sections = await getSections(token, project.id);
  const needed = ['Today', 'Active', 'Inbox', 'Waiting'];
  const sectionMap = {};

  for (let i = 0; i < needed.length; i++) {
    const name = needed[i];
    let section = sections.find(s => s.name === name);
    if (!section) {
      section = await createSection(token, project.id, name, i);
    }
    sectionMap[name.toLowerCase()] = section.id;
  }

  return { projectId: project.id, sectionMap };
}
