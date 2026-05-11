const BASE = 'https://todoist-proxy.michael-ewens.workers.dev/api/v1';

function headers(token, hasBody) {
  const h = { 'Authorization': `Bearer ${token}` };
  if (hasBody) h['Content-Type'] = 'application/json';
  return h;
}

async function request(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(token, !!body),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Todoist API ${res.status}: ${text}`);
  }
  return res.json();
}

async function requestAll(path, token) {
  let all = [];
  let cursor = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = cursor ? `${path}${sep}cursor=${cursor}` : path;
    const data = await request('GET', url, token);
    if (Array.isArray(data)) return data;
    all = all.concat(data.results || data);
    cursor = data.next_cursor || null;
  } while (cursor);
  return all;
}

// Projects
export const getProjects = (token) => requestAll('/projects', token);
export const createProject = (token, name) => request('POST', '/projects', token, { name });

// Sections
export const getSections = (token, projectId) => requestAll(`/sections?project_id=${projectId}`, token);
export const createSection = (token, projectId, name, order) => request('POST', '/sections', token, { project_id: projectId, name, order });

// Tasks
export const getTasks = (token, projectId) => requestAll(`/tasks?project_id=${projectId}`, token);
export const createTask = (token, content, opts = {}) => request('POST', '/tasks', token, { content, ...opts });
export const updateTask = (token, id, opts) => request('POST', `/tasks/${id}`, token, opts);
export const moveTask = (token, id, sectionId) => request('POST', `/tasks/${id}/move`, token, { section_id: sectionId });
export const closeTask = (token, id) => request('POST', `/tasks/${id}/close`, token);
export const deleteTask = (token, id) => request('DELETE', `/tasks/${id}`, token);

// Labels
export const getLabels = (token) => requestAll('/labels', token);
export const createLabel = (token, name) => request('POST', '/labels', token, { name });

// Setup: ensure project + sections exist
export async function ensureSetup(token) {
  const projects = await getProjects(token);
  let project = projects.find(p => p.name === 'Priorities');
  if (!project) {
    project = await createProject(token, 'Priorities');
  }

  const sections = await getSections(token, project.id);
  const needed = ['Today', 'Active', 'Inbox', 'Waiting', 'Radar', 'Projects'];
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
